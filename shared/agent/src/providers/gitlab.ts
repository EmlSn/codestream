"use strict";
import { GraphQLClient } from "graphql-request";
import { flatten, groupBy } from "lodash-es";
import { Response } from "node-fetch";
import * as paths from "path";
import * as qs from "querystring";
import * as nodeUrl from "url";
import { URI } from "vscode-uri";
import { Container, SessionContainer } from "../container";
import { GitRemoteLike } from "../git/models/remote";
import { GitRepository } from "../git/models/repository";
import { ParsedDiffWithMetadata, toRepoName, translatePositionToLineNumber } from "../git/utils";
import { Logger } from "../logger";
import { InternalError, ReportSuppressedMessages } from "../agentError";
import {
	CreateThirdPartyCardRequest,
	DidChangePullRequestCommentsNotificationType,
	DiscussionNode,
	DocumentMarker,
	FetchThirdPartyBoardsResponse,
	FetchThirdPartyCardsResponse,
	FetchThirdPartyPullRequestCommitsRequest,
	FetchThirdPartyPullRequestCommitsResponse,
	FetchThirdPartyPullRequestFilesResponse,
	GetMyPullRequestsRequest,
	GetMyPullRequestsResponse,
	GitLabBoard,
	GitLabCreateCardRequest,
	GitLabCreateCardResponse,
	GitLabLabel,
	GitLabMergeRequest,
	GitLabMergeRequestWrapper,
	ThirdPartyProviderConfig
} from "../protocol/agent.protocol";
import { CSGitLabProviderInfo } from "../protocol/api.protocol";
import { log, lspProvider, Strings } from "../system";
import {
	ApiResponse,
	getRemotePaths,
	ProviderCreatePullRequestRequest,
	ProviderCreatePullRequestResponse,
	ProviderGetForkedReposResponse,
	ProviderGetRepoInfoResponse,
	ProviderVersion,
	PullRequestComment,
	REFRESH_TIMEOUT,
	ThirdPartyIssueProviderBase
} from "./provider";
import { Directives } from "./directives";
import { CodeStreamSession } from "../session";
import { print } from "graphql";
import mergeRequest0Query from "./gitlab/mergeRequest0.graphql";
import mergeRequest1Query from "./gitlab/mergeRequest1.graphql";
import mergeRequestDiscussionQuery from "./gitlab/mergeRequestDiscussions.graphql";
import mergeRequestNoteMutation from "./gitlab/createMergeRequestNote.graphql";
import { merge } from "lodash";
import { GraphqlQueryBuilder } from "./gitlab/graphqlQueryBuilder";
import { gate } from "../system/decorators/gate";
import { parsePatch } from "diff";

interface GitLabProject {
	path_with_namespace: any;
	namespace: {
		path: string;
	};
	id: number;
	path: string;
	issues_enabled: boolean;
	forked_from_project?: GitLabProject;
}

interface GitLabUser {
	id: number;
	name: string;
	username: string;
	avatar_url: string;
}

interface GitLabCurrentUser {
	avatarUrl: string;
	id: number;
	login: string;
	name: string;
}

interface GitLabBranch {
	name: string;
}

@lspProvider("gitlab")
export class GitLabProvider extends ThirdPartyIssueProviderBase<CSGitLabProviderInfo> {
	private _projectsByRemotePath = new Map<string, GitLabProject>();
	private _assignableUsersCache = new Map<string, any>();

	get displayName() {
		return "GitLab";
	}

	get name() {
		return "gitlab";
	}

	get headers(): any {
		return {
			Authorization: `Bearer ${this.accessToken}`,
			"Content-Type": "application/json"
		};
	}

	get apiPath() {
		return "/api/v4";
	}

	get baseUrl() {
		return `${this.baseWebUrl}${this.apiPath}`;
	}

	get baseWebUrl() {
		return `https://gitlab.com`;
	}

	private readonly gitLabReviewStore: GitLabReviewStore;
	private readonly graphqlQueryBuilder: GraphqlQueryBuilder;

	constructor(session: CodeStreamSession, providerConfig: ThirdPartyProviderConfig) {
		super(session, providerConfig);
		this.gitLabReviewStore = new GitLabReviewStore();
		this.graphqlQueryBuilder = new GraphqlQueryBuilder(providerConfig.id);
	}

	async ensureInitialized() {
		await this.getCurrentUser();
	}

	protected getPRExternalContent(comment: PullRequestComment) {
		return {
			provider: {
				name: this.displayName,
				icon: "gitlab",
				id: this.providerConfig.id
			},
			subhead: `!${comment.pullRequest.id}`,
			externalId: comment.pullRequest.externalId,
			externalChildId: comment.id,
			externalType: "PullRequest",
			title: comment.pullRequest.title,
			diffHunk: comment.diffHunk,
			actions: []
			// subhead: `#${comment.pullRequest.id}`,
			// actions: [
			// 	{
			// 		label: "Open Note",
			// 		uri: comment.url
			// 	},
			// 	{
			// 		label: `Open Merge Request !${comment.pullRequest.id}`,
			// 		uri: comment.pullRequest.url
			// 	}
			// ]
		};
	}

	async onConnected(providerInfo?: CSGitLabProviderInfo) {
		super.onConnected(providerInfo);
		this._projectsByRemotePath = new Map<string, GitLabProject>();
	}

	@log()
	async getBoards(): Promise<FetchThirdPartyBoardsResponse> {
		await this.ensureConnected();
		const openProjects = await this.getOpenProjectsByRemotePath();

		let boards: GitLabBoard[];
		if (openProjects.size > 0) {
			const gitLabProjects = Array.from(openProjects.values());
			boards = gitLabProjects
				.filter(p => p.issues_enabled)
				.map(p => ({
					id: p.id.toString(),
					name: p.path_with_namespace,
					path: p.path,
					singleAssignee: true // gitlab only allows a single assignee per issue (at least it only shows one in the UI)
				}));
		} else {
			let gitLabProjects: { [key: string]: string }[] = [];
			try {
				let apiResponse = await this.get<{ [key: string]: string }[]>(
					`/projects?min_access_level=20&with_issues_enabled=true`
				);
				gitLabProjects = apiResponse.body;

				let nextPage: string | undefined;
				while ((nextPage = this.nextPage(apiResponse.response))) {
					apiResponse = await this.get<{ [key: string]: string }[]>(nextPage);
					gitLabProjects = gitLabProjects.concat(apiResponse.body);
				}
			} catch (err) {
				Logger.error(err);
				debugger;
			}
			boards = gitLabProjects.map(p => {
				return {
					...p,
					id: p.id,
					name: p.path_with_namespace,
					path: p.path,
					singleAssignee: true // gitlab only allows a single assignee per issue (at least it only shows one in the UI)
				};
			});
		}

		return {
			boards
		};
	}

	private async getOpenProjectsByRemotePath() {
		const { git } = SessionContainer.instance();
		const gitRepos = await git.getRepositories();
		const openProjects = new Map<string, GitLabProject>();

		for (const gitRepo of gitRepos) {
			const remotes = await git.getRepoRemotes(gitRepo.path);
			for (const remote of remotes) {
				if (this.getIsMatchingRemotePredicate()(remote) && !openProjects.has(remote.path)) {
					let gitlabProject = this._projectsByRemotePath.get(remote.path);

					if (!gitlabProject) {
						try {
							const response = await this.get<GitLabProject>(
								`/projects/${encodeURIComponent(remote.path)}`
							);
							gitlabProject = {
								...response.body,
								path: gitRepo.path
							};
							this._projectsByRemotePath.set(remote.path, gitlabProject);
						} catch (err) {
							Logger.error(err);
							debugger;
						}
					}

					if (gitlabProject) {
						openProjects.set(remote.path, gitlabProject);
					}
				}
			}
		}
		return openProjects;
	}

	@log()
	async createCard(request: CreateThirdPartyCardRequest) {
		await this.ensureConnected();

		const data = request.data as GitLabCreateCardRequest;
		const card: { [key: string]: any } = {
			title: data.title,
			description: data.description
		};
		if (data.assignee) {
			// GitLab allows for multiple assignees in the API, but only one appears in the UI
			card.assignee_ids = [data.assignee.id];
		}
		const response = await this.post<{}, GitLabCreateCardResponse>(
			`/projects/${encodeURIComponent(data.repoName)}/issues?${qs.stringify(card)}`,
			{}
		);
		return { ...response.body, url: response.body.web_url };
	}

	// FIXME
	@log()
	async moveCard() {}

	@log()
	async getCards(): Promise<FetchThirdPartyCardsResponse> {
		await this.ensureConnected();

		const { body } = await this.get<any[]>(
			`/issues?${qs.stringify({
				state: "opened",
				scope: "assigned_to_me"
			})}`
		);
		const cards = body.map(card => {
			return {
				id: card.id,
				url: card.web_url,
				title: card.title,
				modifiedAt: new Date(card.updated_at).getTime(),
				tokenId: card.iid,
				body: card.description
			};
		});
		return { cards };
	}

	private async getMemberId() {
		const userResponse = await this.get<{ id: string; [key: string]: any }>(`/user`);
		return userResponse.body.id;
	}

	private nextPage(response: Response): string | undefined {
		const linkHeader = response.headers.get("Link") || "";
		if (linkHeader.trim().length === 0) return undefined;
		const links = linkHeader.split(",");
		for (const link of links) {
			const [rawUrl, rawRel] = link.split(";");
			const url = rawUrl.trim();
			const rel = rawRel.trim();
			if (rel === `rel="next"`) {
				const baseUrl = this.baseUrl;
				return url.substring(1, url.length - 1).replace(baseUrl, "");
			}
		}
		return undefined;
	}

	@gate()
	@log()
	async getAssignableUsers(request: { boardId: string }) {
		await this.ensureConnected();
		const data = this._assignableUsersCache.get(request.boardId);
		if (data) {
			return data;
		}

		const users = await this._paginateRestResponse(`/projects/${request.boardId}/users`, data => {
			return data.map(u => ({
				...u,
				displayName: u.username,
				login: u.username,
				avatarUrl: this.avatarUrl(u.avatar_url)
			}));
		});
		this._assignableUsersCache.set(request.boardId, { users });
		return { users };
	}

	@log()
	async getPullRequestDocumentMarkers({
		uri,
		repoId,
		streamId
	}: {
		uri: URI;
		repoId: string | undefined;
		streamId: string;
	}): Promise<DocumentMarker[]> {
		return super.getPullRequestDocumentMarkersCore({ uri, repoId, streamId });
	}

	private _commentsByRepoAndPath = new Map<
		string,
		{ expiresAt: number; comments: Promise<PullRequestComment[]> }
	>();

	private _isMatchingRemotePredicate = (r: GitRemoteLike) => r.domain === "gitlab.com";
	getIsMatchingRemotePredicate() {
		return this._isMatchingRemotePredicate;
	}

	async getRemotePaths(repo: any, _projectsByRemotePath: any) {
		// TODO don't need this ensureConnected -- doesn't hit api
		await this.ensureConnected();
		const remotePaths = await getRemotePaths(
			repo,
			this.getIsMatchingRemotePredicate(),
			_projectsByRemotePath
		);
		return remotePaths;
	}

	protected getOwnerFromRemote(remote: string): { owner: string; name: string } {
		// HACKitude yeah, sorry
		const uri = URI.parse(remote);
		const split = uri.path.split("/");

		// the project name is the last item
		let name = split.pop();
		// gitlab & enterprise can use project groups + subgroups
		const owner = split.filter(_ => _ !== "" && _ != null);
		if (name != null) {
			name = toRepoName(name);
		}

		return {
			owner: owner.join("/"),
			name: name!
		};
	}

	@log()
	async createPullRequest(
		request: ProviderCreatePullRequestRequest
	): Promise<ProviderCreatePullRequestResponse | undefined> {
		try {
			void (await this.ensureConnected());

			if (!(await this.isPRApiCompatible())) {
				return {
					error: {
						type: "UNKNOWN",
						message: "PR Api is not compatible"
					}
				};
			}
			const { owner, name } = this.getOwnerFromRemote(request.remote);

			const repoInfo = await this.getRepoInfo({ remote: request.remote });
			if (repoInfo && repoInfo.error) {
				return {
					error: repoInfo.error
				};
			}

			const sourceBranch = request.headRefName.includes(":")
				? request.headRefName.split(":")[1]
				: request.headRefName;

			const createPullRequestResponse = await this.post<
				GitLabCreateMergeRequestRequest,
				GitLabCreateMergeRequestResponse
			>(
				`/projects/${encodeURIComponent(`${owner}/${name}`)}/merge_requests`,
				{
					title: request.title,
					source_branch: sourceBranch,
					target_branch: request.baseRefName,
					target_project_id: request.providerRepositoryId,
					description: this.createDescription(request)
				},
				{
					// couldn't get this post to work without
					// this additional header
					"Content-Type": "application/json"
				}
			);
			const title = `#${createPullRequestResponse.body.iid} ${createPullRequestResponse.body.title}`;

			return {
				title: title,
				url: createPullRequestResponse.body.web_url,
				id: JSON.stringify({
					full: createPullRequestResponse.body.references.full,
					id: createPullRequestResponse.body.id
				})
			};
		} catch (ex) {
			Logger.error(ex, `${this.displayName}: createPullRequest`, {
				remote: request.remote,
				baseRefName: request.baseRefName,
				headRefName: request.headRefName
			});
			return {
				error: {
					type: "PROVIDER",
					message: `${this.displayName}: ${ex.message}`
				}
			};
		}
	}

	async getRepoInfo(request: { remote: string }): Promise<ProviderGetRepoInfoResponse> {
		let owner;
		let name;
		try {
			({ owner, name } = this.getOwnerFromRemote(request.remote));

			let projectResponse;
			try {
				projectResponse = await this.get<GitLabProjectInfoResponse>(
					`/projects/${encodeURIComponent(`${owner}/${name}`)}`
				);
			} catch (ex) {
				Logger.error(ex, `${this.displayName}: failed to get projects`, {
					owner: owner,
					name: name,
					hasProviderInfo: this._providerInfo != null
				});
				return {
					error: {
						type: "PROVIDER",
						message: ex.message
					}
				};
			}
			let mergeRequestsResponse;
			try {
				mergeRequestsResponse = await this.get<GitLabMergeRequestInfoResponse[]>(
					`/projects/${encodeURIComponent(`${owner}/${name}`)}/merge_requests?state=opened`
				);
			} catch (ex) {
				Logger.error(ex, `${this.displayName}: failed to get merge_requests`, {
					owner: owner,
					name: name,
					hasProviderInfo: this._providerInfo != null
				});
				return {
					error: {
						type: "PROVIDER",
						message: ex.message
					}
				};
			}

			return {
				id: (projectResponse.body.iid || projectResponse.body.id)!.toString(),
				defaultBranch: projectResponse.body.default_branch,
				pullRequests: mergeRequestsResponse.body.map(_ => {
					return {
						id: JSON.stringify({ full: _.references.full, id: _.iid.toString() }),
						iid: _.iid.toString(),
						url: _.web_url,
						baseRefName: _.target_branch,
						headRefName: _.source_branch
					};
				})
			};
		} catch (ex) {
			Logger.error(ex, `${this.displayName}: getRepoInfo failed`, {
				owner: owner,
				name: name,
				hasProviderInfo: this._providerInfo != null
			});

			return {
				error: {
					type: "PROVIDER",
					message: ex.message
				}
			};
		}
	}

	async getForkedRepos(
		request: { remote: string },
		recurseFailsafe?: boolean
	): Promise<ProviderGetForkedReposResponse> {
		try {
			const { remote } = request;
			const { owner, name } = this.getOwnerFromRemote(request.remote);

			const projectResponse = await this.get<GitLabProject>(
				`/projects/${encodeURIComponent(`${owner}/${name}`)}`
			);
			const parentProject = projectResponse.body.forked_from_project
				? projectResponse.body.forked_from_project
				: projectResponse.body;

			const branchesByProjectId = new Map<number, GitLabBranch[]>();
			const branchesResponse = await this.get<GitLabBranch[]>(
				`/projects/${encodeURIComponent(parentProject.path_with_namespace)}/repository/branches`
			);
			branchesByProjectId.set(parentProject.id, branchesResponse.body);

			const forksResponse = await this.get<GitLabProject[]>(
				`/projects/${encodeURIComponent(parentProject.path_with_namespace)}/forks`
			);
			for (const project of forksResponse.body) {
				const branchesResponse = await this.get<GitLabBranch[]>(
					`/projects/${encodeURIComponent(project.path_with_namespace)}/repository/branches`
				);
				branchesByProjectId.set(project.id, branchesResponse.body);
			}

			return {
				parent: {
					nameWithOwner: parentProject.path_with_namespace,
					owner: {
						login: parentProject.namespace.path
					},
					id: parentProject.id,
					refs: {
						nodes: branchesByProjectId.get(parentProject.id)!.map(branch => ({ name: branch.name }))
					}
				},
				forks: forksResponse.body.map(fork => ({
					nameWithOwner: fork.path_with_namespace,
					owner: {
						login: fork.namespace.path
					},
					id: fork.id,
					refs: {
						nodes: branchesByProjectId.get(fork.id)!.map(branch => ({ name: branch.name }))
					}
				}))
			};
		} catch (ex) {
			Logger.error(ex, `${this.providerConfig.id}: getForkedRepos`, {
				remote: request.remote
			});
			let errorMessage =
				ex.response && ex.response.errors
					? ex.response.errors[0].message
					: `Unknown ${this.providerConfig.name} error`;
			errorMessage = `${this.providerConfig.name}: ${errorMessage}`;
			return {
				error: {
					type: "PROVIDER",
					message: errorMessage
				}
			};
		}
	}

	@log()
	protected async getCommentsForPath(
		filePath: string,
		repo: GitRepository
	): Promise<PullRequestComment[] | undefined> {
		const cc = Logger.getCorrelationContext();

		try {
			const relativePath = Strings.normalizePath(paths.relative(repo.path, filePath));
			const cacheKey = `${repo.path}|${relativePath}`;

			const cachedComments = this._commentsByRepoAndPath.get(cacheKey);
			if (cachedComments !== undefined && cachedComments.expiresAt > new Date().getTime()) {
				// NOTE: Keep this await here, so any errors are caught here
				return await cachedComments.comments;
			}
			super.invalidatePullRequestDocumentMarkersCache();

			const remotePaths = await getRemotePaths(
				repo,
				this.getIsMatchingRemotePredicate(),
				this._projectsByRemotePath
			);

			const commentsPromise: Promise<PullRequestComment[]> =
				remotePaths != null
					? this._getCommentsForPathCore(filePath, relativePath, remotePaths)
					: Promise.resolve([]);
			this._commentsByRepoAndPath.set(cacheKey, {
				expiresAt: new Date().setMinutes(new Date().getMinutes() + REFRESH_TIMEOUT),
				comments: commentsPromise
			});

			// Since we aren't cached, we want to just kick of the request to get the comments (which will fire a notification)
			// This could probably be enhanced to wait for the commentsPromise for a short period of time (maybe 1s?) to see if it will complete, to avoid the notification roundtrip for fast requests
			return undefined;
		} catch (ex) {
			Logger.error(ex, cc);
			return undefined;
		}
	}

	private async _getCommentsForPathCore(
		filePath: string,
		relativePath: string,
		remotePaths: string[]
	): Promise<PullRequestComment[]> {
		const comments = [];

		for (const remotePath of remotePaths) {
			const prs = await this._getPullRequests(remotePath);

			const prComments = (
				await Promise.all(prs.map(pr => this._getPullRequestComments(remotePath, pr, relativePath)))
			).reduce((group, current) => group.concat(current), []);

			comments.push(...prComments);
		}

		// If we have any comments, fire a notification
		if (comments.length !== 0) {
			void SessionContainer.instance().documentMarkers.fireDidChangeDocumentMarkers(
				URI.file(filePath).toString(),
				"codemarks"
			);
		}

		return comments;
	}

	private async _getPullRequests(remotePath: string): Promise<GitLabPullRequest[]> {
		return flatten(
			await Promise.all([
				this._getPullRequestsByState(remotePath, "opened"),
				this._getPullRequestsByState(remotePath, "merged")
			])
		);
	}

	private async _getPullRequestsByState(
		remotePath: string,
		state: string
	): Promise<GitLabPullRequest[]> {
		const prs: GitLabPullRequest[] = [];

		try {
			let url: string | undefined = `/projects/${encodeURIComponent(
				remotePath
			)}/merge_requests?state=${state}`;
			do {
				const apiResponse = await this.get<GitLabPullRequest[]>(url);
				// Logger.log("Got ack" + JSON.stringify(apiResponse, null, 4));
				prs.push(...apiResponse.body);
				url = this.nextPage(apiResponse.response);
			} while (url);
		} catch (ex) {
			Logger.error(ex);
		}

		prs.forEach(pr => (pr.number = pr.iid));
		return prs;
	}

	private async _getPullRequestComments(
		remotePath: string,
		pr: GitLabPullRequest,
		relativePath: string
	): Promise<PullRequestComment[]> {
		let gitLabComments: GitLabPullRequestComment[] = [];

		try {
			let apiResponse = await this.get<GitLabPullRequestComment[]>(
				`/projects/${encodeURIComponent(remotePath)}/merge_requests/${pr.iid}/notes`
			);
			gitLabComments = apiResponse.body;

			let nextPage: string | undefined;
			while ((nextPage = this.nextPage(apiResponse.response))) {
				apiResponse = await this.get<GitLabPullRequestComment[]>(nextPage);
				gitLabComments = gitLabComments.concat(apiResponse.body);
			}
		} catch (ex) {
			Logger.error(ex);
		}

		return gitLabComments
			.filter(c => !c.system && c.position != null && c.position.new_path === relativePath)
			.map(glComment => {
				return {
					id: glComment.id.toString(),
					author: {
						id: glComment.author.id.toString(),
						nickname: glComment.author.name,
						login: glComment.author.name
					},
					path: glComment.position.new_path,
					text: glComment.body,
					code: "",
					commit: glComment.position.head_sha,
					originalCommit: glComment.position.base_sha,
					line: glComment.position.new_line,
					originalLine: glComment.position.old_line,
					url: `${pr.web_url}#note_${glComment.id}`,
					createdAt: new Date(glComment.created_at).getTime(),
					pullRequest: {
						id: pr.iid,
						externalId: JSON.stringify({ full: pr.references?.full, id: pr.id }),
						url: pr.web_url,
						isOpen: pr.state === "opened",
						targetBranch: pr.target_branch,
						sourceBranch: pr.source_branch,
						title: pr.title
					}
				};
			});
	}

	async getMyPullRequests(
		request: GetMyPullRequestsRequest
	): Promise<GetMyPullRequestsResponse[][] | undefined> {
		void (await this.ensureConnected());
		const currentUser = await this.getCurrentUser();

		let repos: string[] = [];
		if (request.isOpen) {
			try {
				repos = await this.getOpenedRepos();
				if (!repos.length) {
					Logger.log(`getMyPullRequests: request.isOpen=true, but no repos found, returning empty`);
					return [];
				}
			} catch (ex) {
				Logger.warn(ex);
			}
		}

		const queries = request.queries.map(query =>
			query === "recent" ? "scope:created_by_me per_page:5" : query
		);

		let items;
		let promises: Promise<ApiResponse<any>>[] = [];
		const createQueryString = (query: string) =>
			query
				.trim()
				.split(" ")
				.map(kvp => this.toKeyValuePair(kvp, currentUser))
				.join("&");

		if (repos.length) {
			// https://docs.gitlab.com/ee/api/merge_requests.html
			const buildUrl = (repo: string, query: string) => {
				return `/projects/${encodeURIComponent(repo)}/merge_requests?${createQueryString(
					query
				)}&with_labels_details=true`;
			};

			for (const query of queries) {
				const splits = query.split(",");
				if (splits.length > 1) {
					let results: any = { body: {} };
					const splitPromises = [];
					for (const split of splits) {
						for (const repo of repos) {
							splitPromises.push(this.get<any>(buildUrl(repo, split)));
						}
					}
					const resolveSplitPromises = await Promise.all(splitPromises);
					// merge the results of the split promises so that it appears as if it's 1 query
					results = merge(results, ...resolveSplitPromises);
					promises.push(new Promise(resolve => resolve(results)));
				} else {
					splits.forEach(split => {
						repos.forEach(repo => {
							promises.push(this.get<any>(buildUrl(repo, split)));
						});
					});
				}
			}
		} else {
			const buildUrl = (query: string) => {
				return `/merge_requests?${createQueryString(query)}&with_labels_details=true`;
			};

			for (const query of queries) {
				const splits = query.split(",");
				if (splits.length > 1) {
					let results: any = { body: {} };
					const splitPromises = [];
					for (const split of splits) {
						splitPromises.push(this.get<any>(buildUrl(split)));
					}
					const resolveSplitPromises = await Promise.all(splitPromises);
					// merge the results of the split promises so that it appears as if it's 1 query
					results = merge(results, ...resolveSplitPromises);
					promises.push(new Promise(resolve => resolve(results)));
				} else {
					splits.forEach(split => {
						promises.push(this.get<any>(buildUrl(split)));
					});
				}
			}
		}

		items = await Promise.all(promises).catch(ex => {
			Logger.error(ex);
			let errString;
			if (ex.response) {
				errString = JSON.stringify(ex.response);
			} else {
				errString = ex.message;
			}
			throw new Error(errString);
		});

		const response: any[][] = [];
		items.forEach((item: any, index) => {
			if (item && item.body) {
				response[index] = item.body
					.filter((_: any) => _.id)
					.map(
						(pr: {
							created_at: string;
							id: string;
							iid: string;
							references: { full: string };
						}) => ({
							...pr,
							base_id: pr.id,
							// along the way, this id will need to be baked
							// (used in toast notifications which later needs a singular id)
							id: JSON.stringify({ full: pr.references.full, id: pr.id }),
							providerId: this.providerConfig?.id,
							createdAt: new Date(pr.created_at).getTime(),
							number: parseInt(pr.iid, 10)
						})
					);

				if (queries[index] && !queries[index].match(/\bsort:/)) {
					response[index] = response[index].sort(
						(a: { created_at: number }, b: { created_at: number }) => b.created_at - a.created_at
					);
				}
			}
		});

		return response;
	}

	get graphQlBaseUrl() {
		return `${this.baseUrl.replace("/v4", "")}/graphql`;
	}

	private _providerVersions = new Map<string, ProviderVersion>();

	@gate()
	async getVersion(): Promise<ProviderVersion> {
		let version;
		try {
			// a user could be connected to both GL and GL self-managed
			version = this._providerVersions.get(this.providerConfig.id);
			if (version) return version;

			const response = await this.get<{
				version: string;
				revision: string;
			}>("/version");

			const split = response.body.version.split("-");
			const versionOrDefault = split[0] || "0.0.0";
			version = {
				version: versionOrDefault,
				asArray: versionOrDefault.split(".").map(Number),
				edition: split.length > 1 ? split[1] : undefined,
				revision: response.body.revision
			};

			Logger.log(
				`${this.providerConfig.id} getVersion - ${this.providerConfig.id} version=${JSON.stringify(
					version
				)}`
			);

			Container.instance().errorReporter.reportBreadcrumb({
				message: `${this.providerConfig.id} getVersion`,
				data: {
					...version
				}
			});
		} catch (ex) {
			Logger.warn(ex, "getVersion");
			version = this.DEFAULT_VERSION;
		}

		this._providerVersions.set(this.providerConfig.id, version);
		return version;
	}

	protected async client(): Promise<GraphQLClient> {
		if (this._client === undefined) {
			const options: { [key: string]: any } = {};
			if (this._httpsAgent) {
				options.agent = this._httpsAgent;
			}
			this._client = new GraphQLClient(this.graphQlBaseUrl, options);
		}
		if (!this.accessToken) {
			throw new Error("Could not get a GitLab personal access token");
		}

		this._client.setHeaders({
			Authorization: `Bearer ${this.accessToken}`
		});

		return this._client;
	}

	_queryLogger: {
		restApi: {
			rateLimit?: { remaining: number; limit: number; used: number; reset: number };
			fns: any;
		};
		graphQlApi: {
			rateLimit?: {
				remaining: number;
				resetAt: string;
				resetInMinutes: number;
				last?: { name: string; cost: number };
			};
			fns: any;
		};
	} = {
		graphQlApi: { fns: {} },
		restApi: { fns: {} }
	};

	async query<T = any>(query: string, variables: any = undefined) {
		if (this._providerInfo && this._providerInfo.tokenError) {
			delete this._client;
			throw new InternalError(ReportSuppressedMessages.AccessTokenInvalid);
		}

		let response;
		try {
			response = await (await this.client()).request<any>(query, variables);
		} catch (ex) {
			Logger.warn("GitLab query caught:", ex);
			const exType = this._isSuppressedException(ex);
			if (exType !== undefined) {
				if (exType !== ReportSuppressedMessages.NetworkError) {
					this.trySetThirdPartyProviderInfo(ex, exType);
				}
				// this throws the error but won't log to sentry (for ordinary network errors that seem temporary)
				throw new InternalError(exType, { error: ex });
			} else {
				// this is an unexpected error, throw the exception normally
				throw ex;
			}
		}

		return response as T;
	}

	async mutate<T>(query: string, variables: any = undefined) {
		return (await this.client()).request<T>(query, variables);
	}

	async get<T extends object>(url: string): Promise<ApiResponse<T>> {
		// override the base to add additional error handling
		let response;
		try {
			response = await super.get<T>(url);
		} catch (ex) {
			Logger.warn(`${this.providerConfig.name} query caught:`, ex);
			const exType = this._isSuppressedException(ex);
			if (exType !== undefined) {
				// this throws the error but won't log to sentry (for ordinary network errors that seem temporary)
				throw new InternalError(exType, { error: ex });
			} else {
				// this is an unexpected error, throw the exception normally
				throw ex;
			}
		}

		return response;
	}

	async restGet<T extends object>(url: string) {
		return this.get<T>(url);
	}

	async restPost<T extends object, R extends object>(url: string, variables: any) {
		return this.post<T, R>(url, variables);
	}

	async restPut<T extends object, R extends object>(url: string, variables: any) {
		return this.put<T, R>(url, variables);
	}
	async restDelete<R extends object>(url: string, options: { useRawResponse: boolean }) {
		return this.delete<R>(url, {}, options);
	}

	/**
	 * Gets the current user based on the GL providerId
	 *
	 * @memberof GitLabProvider
	 */
	_currentGitlabUsers = new Map<string, GitLabCurrentUser>();

	@gate()
	async getCurrentUser(): Promise<GitLabCurrentUser> {
		let currentUser = this._currentGitlabUsers.get(this.providerConfig.id);
		if (currentUser) return currentUser;

		const data = await this.restGet<{
			id: number;
			username: string;
			name: string;
			avatar_url: string;
		}>("/user");
		currentUser = {
			id: data.body.id,
			login: data.body.username,
			name: data.body.name,
			avatarUrl: data.body.avatar_url
		} as GitLabCurrentUser;

		currentUser = this.toAuthorAbsolutePath(currentUser);
		this._currentGitlabUsers.set(this.providerConfig.id, currentUser);

		Logger.log(`getCurrentUser ${JSON.stringify(currentUser)} for id=${this.providerConfig.id}`);
		return currentUser;
	}

	_pullRequestCache: Map<string, GitLabMergeRequestWrapper> = new Map();
	_ignoredFeatures: Map<"approvals", boolean> = new Map();

	async getReviewers(request: { pullRequestId: string }) {
		const { projectFullPath } = this.parseId(request.pullRequestId);

		const users = await this.getAssignableUsers({ boardId: encodeURIComponent(projectFullPath) });
		return users;
	}

	@log()
	async getPullRequest(request: {
		pullRequestId: string;
		force?: boolean;
	}): Promise<GitLabMergeRequestWrapper> {
		const { projectFullPath, id, iid } = this.parseId(request.pullRequestId);

		void (await this.ensureConnected());
		const currentUser = await this.getCurrentUser();
		const providerVersion = await this.getVersion();

		if (request.force) {
			this._pullRequestCache.delete(id);
		} else {
			const cached = this._pullRequestCache.get(id);
			if (cached) {
				return cached;
			}
		}

		let response = {} as GitLabMergeRequestWrapper;
		try {
			let discussions: DiscussionNode[] = [];
			let i = 0;
			const args = {
				fullPath: projectFullPath,
				iid: iid.toString()
			};
			const queryText0 = await this.graphqlQueryBuilder.build(
				providerVersion!.version!,
				mergeRequest0Query,
				"GetPullRequest"
			);

			// NOTE we are running TWO queries since they're kind of heavy and some GL instances
			// have been known to crash. oops.
			let response0 = await this.query(queryText0, args);
			discussions = discussions.concat(response0.project.mergeRequest.discussions.nodes);
			if (response0.project.mergeRequest.discussions.pageInfo?.hasNextPage) {
				let after = response0.project.mergeRequest.discussions.pageInfo.endCursor;
				const paginatedDiscussionQuery = print(mergeRequestDiscussionQuery);
				while (true) {
					const paginated = await this.query(paginatedDiscussionQuery, {
						...args,
						after: after,
						first: 100
					});
					discussions = discussions.concat(paginated.project.mergeRequest.discussions.nodes);
					if (paginated.project.mergeRequest.discussions.pageInfo?.hasNextPage) {
						after = paginated.project.mergeRequest.discussions.pageInfo.endCursor;
						i++;
						Logger.log(`getPullRequest paginating discussions ${i}`);
					} else {
						break;
					}
				}
			}

			const queryText1 = await this.graphqlQueryBuilder.build(
				providerVersion!.version!,
				mergeRequest1Query,
				"GetPullRequest1"
			);

			const response1 = await this.query(queryText1, args);
			response = merge(
				{
					project: {
						mergeRequest: {
							discussions: {
								nodes: []
							}
						}
					}
				},
				response0,
				response1
			);
			response.currentUser = {
				...currentUser,
				id: `gid://gitlab/User/${currentUser.id}`
			};

			response.project.mergeRequest.discussions.nodes = discussions;

			// massage the authors to get a fully qualified url
			this.toAuthorAbsolutePath(response.project.mergeRequest.author);
			[
				response.project.mergeRequest.approvedBy,
				response.project.mergeRequest.assignees,
				response.project.mergeRequest.participants,
				response.project.mergeRequest.reviewers
			].forEach(_ => {
				if (_?.nodes) {
					_.nodes.forEach((node: any) => {
						this.toAuthorAbsolutePath(node);
					});
				}
			});

			// project settings
			const project = await this.restGet<{
				merge_method: string;
				only_allow_merge_if_all_discussions_are_resolved: boolean;
				only_allow_merge_if_pipeline_succeeds: boolean;
				allow_merge_on_skipped_pipeline: boolean;
			}>(`/projects/${encodeURIComponent(projectFullPath)}`);

			response.project.mergeMethod = project.body.merge_method!;
			response.project.allowMergeOnSkippedPipeline = project.body.allow_merge_on_skipped_pipeline;
			response.project.onlyAllowMergeIfAllDiscussionsAreResolved =
				project.body.only_allow_merge_if_all_discussions_are_resolved;
			response.project.onlyAllowMergeIfPipelineSucceeds =
				project.body.only_allow_merge_if_pipeline_succeeds;
			const users = await this.getAssignableUsers({ boardId: encodeURIComponent(projectFullPath) });

			// if you are part of the project, you will see the approve box UI
			// from there there can be further restrictions
			response.project.mergeRequest.userPermissions.canAssign = response.project.mergeRequest.userPermissions.canApprove = !!users?.users.find(
				(_: any) => _.username === response.currentUser.login
			);

			try {
				if (this._ignoredFeatures.get("approvals") !== true) {
					// approval settings
					const approvals = await this.restGet<{
						merge_requests_author_approval: boolean;
					}>(`/projects/${encodeURIComponent(projectFullPath)}/approvals`);
					response.project.mergeRequest.approvalsAuthorCanApprove =
						approvals.body.merge_requests_author_approval;
				}
			} catch (ex) {
				Logger.warn("approvals", { error: ex });
				this._ignoredFeatures.set("approvals", true);
				Logger.log("Ignoring 'approvals'");
			}

			// merge request settings
			const mergeRequest = await this.restGet<{
				diverged_commits_count: number;
			}>(
				`/projects/${encodeURIComponent(
					projectFullPath
				)}/merge_requests/${iid}?include_diverged_commits_count=true`
			);
			response.project.mergeRequest.divergedCommitsCount =
				mergeRequest.body.diverged_commits_count || 0;

			if (response.project?.mergeRequest?.headPipeline) {
				response.project.mergeRequest.headPipeline.gid =
					response.project.mergeRequest.headPipeline.id;
				response.project.mergeRequest.headPipeline.id = response.project.mergeRequest.headPipeline.id.replace(
					"gid://gitlab/Ci::Pipeline/",
					""
				);
				response.project.mergeRequest.headPipeline.webUrl = `${this.baseWebUrl}/${response.project.mergeRequest.project.fullPath}/-/pipelines/${response.project.mergeRequest.headPipeline.id}`;
			}

			const base_id = this.fromMergeRequestGid(response.project.mergeRequest.id);
			// build this so that it aligns with what the REST api created
			response.project.mergeRequest.references = {
				full: `${projectFullPath}!${iid}`
			};
			const mergeRequestFullId = JSON.stringify({
				id: base_id,
				full: response.project.mergeRequest.references.full
			});

			// NOTE the following are _supposed_ to exist on the graph results, butttt
			// if they're null, try and fetch them from the commits
			if (response.project.mergeRequest.commitCount == null) {
				response.project.mergeRequest.commitCount = (
					await this.getPullRequestCommits({
						providerId: this.providerConfig.id,
						pullRequestId: mergeRequestFullId
					})
				)?.length;
			}
			const filesChanged = await this.getPullRequestFilesChanged({
				pullRequestId: mergeRequestFullId
			});
			response.project.mergeRequest.changesCount = filesChanged?.length;

			// awards are "reactions" aka "emojis"
			const awards = await this.restGet<any>(
				`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/award_emoji`
			);
			// massage awards into a model we want
			const grouped = groupBy(awards.body, (_: { name: string }) => _.name);
			response.project.mergeRequest.reactionGroups =
				Object.keys(grouped).map(_ => {
					const data = grouped[_];
					data.forEach(r => {
						r.user.login = r.user.username;
						r.user.avatarUrl = this.avatarUrl(r.user.avatar_url);
					});
					return { content: _, data };
				}) || [];

			response.project.mergeRequest = {
				...response.project.mergeRequest,
				providerId: this.providerConfig?.id,
				baseRefOid:
					response.project.mergeRequest.diffRefs && response.project.mergeRequest.diffRefs.baseSha,
				baseRefName: response.project.mergeRequest.targetBranch,
				headRefOid:
					response.project.mergeRequest.diffRefs && response.project.mergeRequest.diffRefs.headSha,
				headRefName: response.project.mergeRequest.sourceBranch,
				repository: {
					name: response.project.mergeRequest.project.name,
					nameWithOwner: response.project.mergeRequest.project.fullPath,
					url: response.project.mergeRequest.project.webUrl
				},
				number: parseInt(response.project.mergeRequest.iid, 10),
				url: response.project.mergeRequest.project.webUrl,
				baseWebUrl: this.baseWebUrl,
				merged: !!response.project.mergeRequest.mergedAt,
				idComputed: mergeRequestFullId,
				viewer: {
					id: response.currentUser.id,
					login: response.currentUser.login,
					name: response.currentUser.name,
					avatarUrl: this.avatarUrl(response.currentUser.avatarUrl),
					// we don't really have a great mapping here...
					viewerCanDelete: response.project.mergeRequest.userPermissions.adminMergeRequest
				}
			};

			const parsedPatches = new Map<string, ParsedDiffWithMetadata>();
			// massage into replies
			response.project.mergeRequest.discussions.nodes.forEach((_: DiscussionNode) => {
				if (_.notes && _.notes.nodes && _.notes.nodes.length) {
					_.notes.nodes.forEach((n: any) => {
						if (n.discussion && n.discussion.id) {
							// HACK hijack the "databaseId" that github uses
							n.databaseId = n.discussion.id
								.replace("gid://gitlab/DiffDiscussion/", "")
								.replace("gid://gitlab/IndividualNoteDiscussion/", "");
							n.mergeRequestIdComputed = mergeRequestFullId;
							this.toAuthorAbsolutePath(n.author);
						}
						if (n.position?.diffRefs && n.position?.newPath && filesChanged?.length) {
							try {
								let processedPatch = parsedPatches.get(n.position.newPath);
								if (!processedPatch) {
									const found = filesChanged.find(_ => _.filename === n.position.newPath);
									if (found?.patch) {
										processedPatch = translatePositionToLineNumber(parsePatch(found.patch)[0]);
										if (processedPatch) {
											parsedPatches.set(n.position.newPath, processedPatch);
										}
									}
								}
								if (processedPatch?.hunks && processedPatch.hunks.length > 0) {
									const lines = processedPatch?.hunks[0].linesWithMetadata
										.filter(
											_ =>
												_.lineNumber &&
												_.lineNumber <= n.position.newLine &&
												_.lineNumber >= n.position.newLine - 7
										)
										.map(_ => _.line);
									const length = lines?.length || 1;
									const start = n.position.newLine + 1 - length;
									const header = `@@ -${start},${length} +${start},${n.position.newLine} @@`;
									n.position.patch = header + "\n" + lines?.join("\n");
								}
							} catch (ex) {
								Logger.warn("getMergeRequest diffs", {
									error: ex
								});
							}
						}
					});
					_.notes.nodes[0].replies = _.notes.nodes.filter(
						(x: any) => x.id != _.notes?.nodes[0].id
					) as any;
					// remove all the replies from the parent (they're now on replies)
					_.notes.nodes.length = 1;
				}
			});

			// add reviews
			const pendingReview = await this.gitLabReviewStore.get(new GitLabId(projectFullPath, iid));
			if (pendingReview?.comments?.length) {
				const commentsAsDiscussionNodes = pendingReview.comments.map(_ => {
					return this.gitLabReviewStore.mapToDiscussionNode(_, currentUser);
				});
				response.project.mergeRequest.discussions.nodes = response.project.mergeRequest.discussions.nodes.concat(
					commentsAsDiscussionNodes
				);
				response.project.mergeRequest.pendingReview = {
					id: "undefined",
					author: commentsAsDiscussionNodes[0].notes?.nodes[0].author!,
					comments: {
						totalCount: pendingReview.comments.length
					}
				};
			}
			response.project.mergeRequest.viewerDidAuthor =
				response.project.mergeRequest.author.login == response.currentUser.login;

			// get all timeline events
			(
				await Promise.all([
					this.getLabelEvents(projectFullPath, iid),
					this.getMilestoneEvents(projectFullPath, iid),
					this.getStateEvents(projectFullPath, iid)
				]).catch(ex => {
					Logger.error(ex);
					throw ex;
				})
			).forEach(_ => response.project.mergeRequest.discussions.nodes.push(..._));

			// sort all the nodes
			response.project.mergeRequest.discussions.nodes.sort((a: DiscussionNode, b: DiscussionNode) =>
				a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
			);

			response.project.mergeRequest.supports = this.graphqlQueryBuilder.getOrCreateSupportMatrix(
				"GetPullRequest",
				providerVersion
			);

			this._pullRequestCache.set(id, response);
		} catch (ex) {
			Logger.error(ex, "getMergeRequest", {
				...request
			});
			return {
				error: {
					message: ex.message
				}
			} as any;
		}

		return response;
	}

	@log()
	async createCommentReply(request: {
		pullRequestId: string;
		parentId: string;
		text: string;
	}): Promise<Directives> {
		if (!request.parentId) throw new Error("ParentId missing");

		const { id } = this.parseId(request.pullRequestId);
		const response = await this.query<any>(
			`mutation createNote($noteableId: NoteableID!, $discussionId: DiscussionID!, $body: String!) {
			createNote(input: {noteableId: $noteableId, discussionId: $discussionId, body: $body}) {
			  clientMutationId
			  note {
				author {
					name
					login: username
					avatarUrl
				  }
				  body
				  bodyHtml
				  createdAt
				  discussion {
					id
					replyId
					createdAt
				  }
				  id
				  resolvable
				  resolved
				  updatedAt
				  userPermissions {
					adminNote
					readNote
					resolveNote
					awardEmoji
					createNote
				  }
			  }
			}
		  }
		  `,
			{
				// mergeRequest
				noteableId: this.toMergeRequestGid(id),
				// the parent discussion
				discussionId: request.parentId,
				body: request.text
			}
		);
		this.toAuthorAbsolutePath(response.createNote.note.author);
		return {
			directives: [{ type: "addReply", data: response.createNote.note }]
		};
	}

	@log()
	async createPullRequestThread(request: { pullRequestId: string; text: string }) {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		try {
			const data = await this.restPost<
				{
					body: string;
				},
				{
					id: string;
				}
			>(`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/discussions`, {
				body: request.text
			});
			const body = data.body;
			const id = body.id;

			const response = (await this.query(print(mergeRequestDiscussionQuery), {
				fullPath: projectFullPath,
				iid: iid.toString(),
				last: 5
			})) as GitLabMergeRequestWrapper;

			const node = response?.project?.mergeRequest?.discussions?.nodes.find(
				_ => _.id === `gid://gitlab/Discussion/${id}`
			);
			if (node) {
				this.ensureAvatarAbsolutePathRecurse(node);
				return {
					directives: [{ type: "addNode", data: node }]
				};
			} else {
				// if for some reason the id can't be found, the client can de-dupe
				this.ensureAvatarAbsolutePathRecurse(response?.project?.mergeRequest?.discussions || {});
				return {
					directives: [
						{ type: "addNodes", data: response?.project?.mergeRequest?.discussions.nodes || [] }
					]
				};
			}
		} catch (ex) {
			Logger.error(ex, "createPullRequestThread");
			throw ex;
		}
	}

	@log()
	async getPullRequestReviewId(request: { pullRequestId: string }) {
		const { iid, projectFullPath } = this.parseId(request.pullRequestId);
		const exists = this.gitLabReviewStore.exists(new GitLabId(projectFullPath, iid));
		return exists;
	}

	@log()
	async createPullRequestInlineReviewComment(request: {
		pullRequestId: string;
		text: string;
		filePath: string;
		oldLineNumber?: number | undefined;
		startLine?: number;
		position: number;
		leftSha?: string;
		sha?: string;
	}) {
		const result = await this.createPullRequestReviewComment(request);
		return result;
	}

	@log()
	async addComment(request: { subjectId: string; text: string }): Promise<any> {
		// // does not require return directives
		const { id } = this.parseId(request.subjectId);
		const response = await this.mutate(
			`mutation CreateNote($noteableId:ID!, $body:String!){
				createNote(input: {noteableId:$noteableId, body:$body}){
					clientMutationId				
		  	}
		}`,
			{
				noteableId: this.toMergeRequestGid(id),
				body: request.text
			}
		);
		return response;
	}

	@log()
	async createPullRequestReviewComment(request: {
		pullRequestId: string;
		pullRequestReviewId?: string;
		text: string;
		filePath?: string;
		oldLineNumber?: number | undefined;
		startLine?: number;
		position?: number;
		leftSha?: string;
		sha?: string;
	}) {
		const { id, iid, projectFullPath } = this.parseId(request.pullRequestId);

		Logger.log(`createPullRequestReviewComment project=${projectFullPath} iid=${iid}`, {
			request: request
		});

		this.gitLabReviewStore.add(new GitLabId(projectFullPath, iid), {
			...request,
			createdAt: new Date().toISOString()
		});

		this._pullRequestCache.delete(id);
		this.session.agent.sendNotification(DidChangePullRequestCommentsNotificationType, {
			pullRequestId: id,
			filePath: request.filePath
		});

		return true;
	}

	@log()
	async submitReview(request: {
		pullRequestId: string;
		text: string;
		eventType: string;
		// used with old servers
		pullRequestReviewId?: string;
	}) {
		const { id, iid, projectFullPath } = this.parseId(request.pullRequestId);

		// TODO add directives
		if (!request.eventType) {
			request.eventType = "COMMENT";
		}
		if (
			request.eventType !== "COMMENT" &&
			request.eventType !== "APPROVE" &&
			// for some reason I cannot get DISMISS to work...
			// request.eventType !== "DISMISS" &&
			request.eventType !== "REQUEST_CHANGES"
		) {
			throw new Error("Invalid eventType");
		}

		const existingReviewComments = await this.gitLabReviewStore.get(
			new GitLabId(projectFullPath, iid)
		);
		if (existingReviewComments?.comments?.length) {
			for (const comment of existingReviewComments.comments) {
				try {
					await this.createPullRequestInlineComment({
						...comment,
						pullRequestId: request.pullRequestId
					});
				} catch (ex) {
					Logger.warn(ex, "Failed to add commit");
				}
			}
			await this.gitLabReviewStore.deleteReview(new GitLabId(projectFullPath, iid));
		}

		if (request.text) {
			await this.createPullRequestComment({
				pullRequestId: request.pullRequestId,
				text: request.text,
				noteableId: id
			});
		}

		return true;
	}

	@log()
	async updatePullRequestSubscription(request: { pullRequestId: string; onOff: boolean }) {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		const type = request.onOff ? "subscribe" : "unsubscribe";
		const data = await this.restPost<{}, { subscribed: string }>(
			`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/${type}`,
			{}
		);

		return {
			directives: [
				{
					type: "updatePullRequest",
					data: {
						subscribed: data.body.subscribed
					}
				}
			]
		};
	}

	@log()
	async setReviewersOnPullRequest(request: { ids: string[]; pullRequestId: string }) {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);
		const data = await this.restPut<{ reviewer_ids: number[] }, { reviewers: any[] }>(
			`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}`,
			{
				reviewer_ids: request.ids
			}
		);
		const lastDiscussions = await this.getLastDiscussions(projectFullPath, iid);
		return {
			directives: [
				{
					type: "addNodes",
					data: lastDiscussions
				},
				{
					type: "updateReviewers",
					data: data.body.reviewers.map(_ => {
						return { ..._, login: _.username, avatarUrl: this.avatarUrl(_.avatar_url) };
					})
				}
			]
		};
	}

	@log()
	async setAssigneeOnPullRequest(request: {
		pullRequestId: string;
		ids: number[] | undefined;
	}): Promise<Directives | undefined> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		try {
			const requestBody: {
				assignee_id?: string;
				assignee_ids?: string;
			} = {};
			if (!request.ids || !request.ids.length) {
				requestBody.assignee_id = "0";
			} else {
				if (request.ids.length > 1) {
					requestBody.assignee_ids = request.ids.join(",");
				} else {
					requestBody.assignee_id = request.ids[0] + "";
				}
			}

			const { body } = await this.restPut<any, any>(
				`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}`,
				requestBody
			);
			return {
				directives: [
					{
						type: "updatePullRequest",
						data: {
							assignees: {
								nodes: body.assignees.map((assignee: any) => {
									return {
										...assignee,
										id: `gid://gitlab/User/${assignee.id}}`,
										login: assignee.username,
										avatarUrl: this.avatarUrl(assignee.avatar_url)
									};
								})
							}
						}
					}
				]
			};
		} catch (err) {
			Logger.error(err);
			debugger;
		}
		return undefined;
	}

	parseId(pullRequestId: string) {
		const parsed = JSON.parse(pullRequestId);
		// https://gitlab.com/gitlab-org/gitlab/-/blob/1cb9fe25/doc/api/README.md#id-vs-iid
		// id - Is unique across all issues and is used for any API call
		// iid - Is unique only in scope of a single project. When you browse issues or merge requests with the Web UI, you see the iid
		return {
			id: parsed.id,
			projectFullPath: parsed.full.split("!")[0],
			iid: parsed.full.split("!")[1]
		};
	}

	async lockPullRequest(request: { pullRequestId: string }): Promise<Directives> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		const data = await this.restPut<{}, { discussion_locked: boolean }>(
			`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}`,
			{ discussion_locked: true }
		);

		return {
			directives: [
				{
					type: "updatePullRequest",
					data: {
						discussionLocked: data.body.discussion_locked
					}
				}
			]
		};
	}

	async unlockPullRequest(request: { pullRequestId: string }): Promise<Directives> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		const data = await this.restPut<{}, { discussion_locked: boolean }>(
			`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}`,
			{ discussion_locked: false }
		);

		return {
			directives: [
				{
					type: "updatePullRequest",
					data: {
						discussionLocked: data.body.discussion_locked
					}
				}
			]
		};
	}

	async remoteBranches(request: { pullRequestId: string }) {
		const { projectFullPath } = this.parseId(request.pullRequestId);

		const data = await this.restGet(
			`/projects/${encodeURIComponent(projectFullPath)}/repository/branches`
		);

		return data.body;
	}

	async updatePullRequest(request: {
		pullRequestId: string;
		targetBranch: string;
		title: string;
		description: string;
		labels: string;
		availableLabels: GitLabLabel[];
		milestoneId: string;
		assigneeIds: string;
		reviewerIds?: string;
		// deleteSourceBranch?: boolean;
		// squashCommits?: boolean;
	}): Promise<Directives | undefined> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		try {
			const updateReviewers = request.reviewerIds != undefined;
			const requestBody: {
				target_branch: string;
				title: string;
				description: string;
				labels: string;
				assignee_id?: string;
				assignee_ids?: string;
				reviewer_ids?: string;
				milestone_id: string;
			} = {
				target_branch: request.targetBranch,
				title: request.title,
				description: request.description,
				labels: request.labels,
				assignee_id: request.assigneeIds || "0",
				milestone_id: request.milestoneId
				// squash: !!request.squashCommits
			};
			if (request.assigneeIds.includes(",")) {
				delete requestBody.assignee_id;
				requestBody.assignee_ids = request.assigneeIds;
			}
			if (updateReviewers) {
				requestBody.reviewer_ids = request.reviewerIds || "0";
			}
			const { body } = await this.restPut<any, any>(
				`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}`,
				requestBody
			);
			Logger.log("editPullRequest response: " + JSON.stringify(body, null, 4));
			const milestone = body.milestone || null;
			if (milestone) {
				milestone.createdAt = milestone.created_at;
				milestone.dueDate = milestone.due_date;
			}
			return {
				directives: [
					{
						type: "updatePullRequest",
						data: {
							title: body.title,
							workInProgress: body.work_in_progress,
							description: body.description,
							targetBranch: body.target_branch,
							assignees: {
								nodes: body.assignees.map((assignee: any) => {
									return {
										...assignee,
										id: `gid://gitlab/User/${assignee.id}}`,
										login: assignee.username,
										avatarUrl: this.avatarUrl(assignee.avatar_url)
									};
								})
							},
							reviewers: updateReviewers
								? {
										nodes: body.reviewers.map((reviewer: any) => {
											return {
												...reviewer,
												login: reviewer.username,
												avatarUrl: this.avatarUrl(reviewer.avatar_url)
											};
										})
								  }
								: undefined,
							milestone,
							labels: {
								nodes: body.labels
									.map((labelTitle: string) => {
										return request.availableLabels.find(label => label.title === labelTitle);
									})
									.filter(Boolean)
							}
							// squashOnMerge: body.squash
							// shouldRemoveSourceBranch: body.force_remove_source_branch
						}
					},
					{
						type: "addNodes",
						data: await this.getMilestoneEvents(projectFullPath, iid)
					}
				]
			};
		} catch (ex) {
			Logger.warn(ex.message);
		}
		return undefined;
	}

	async createToDo(request: { pullRequestId: string }): Promise<Directives> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		const data = await this.restPost<{}, { state: string }>(
			`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/todo`,
			{}
		);

		return {
			directives: [
				{
					type: "updatePullRequest",
					data: {
						currentUserTodos: {
							nodes: [data.body]
						}
					}
				}
			]
		};
	}

	async markToDoDone(request: { id: string }): Promise<Directives> {
		const id = request.id.toString().replace(/.*Todo\//, "");
		const data = await this.restPost<{}, { state: string }>(`/todos/${id}/mark_as_done`, {});

		return {
			directives: [
				{
					type: "updatePullRequest",
					data: {
						currentUserTodos: {
							nodes: [data.body]
						}
					}
				}
			]
		};
	}

	async getMilestones(request: { pullRequestId: string }) {
		const { projectFullPath } = this.parseId(request.pullRequestId);

		const data = await this.restGet(`/projects/${encodeURIComponent(projectFullPath)}/milestones`);
		return data.body;
	}

	async getLabels(request: { pullRequestId: string }) {
		const { projectFullPath } = this.parseId(request.pullRequestId);

		const { body = [] } = await this.restGet<any[]>(
			`/projects/${encodeURIComponent(projectFullPath)}/labels`
		);
		return body.map(label => {
			return { ...label, title: label.name };
		});
	}

	@log()
	async createPullRequestComment(request: {
		pullRequestId: string;
		text: string;
		noteableId?: string;
		projectFullPath?: string;
		iid?: string;
	}): Promise<Directives> {
		let noteableId;

		const { projectFullPath, id, iid } = this.parseId(request.pullRequestId);

		request.projectFullPath = projectFullPath;
		request.iid = iid;
		noteableId = id;
		request.noteableId = this.toMergeRequestGid(noteableId);

		const response = (await this.mutate(print(mergeRequestNoteMutation), {
			noteableId: request.noteableId,
			body: request.text,
			iid: request.iid!.toString()
		})) as {
			createNote: {
				note: {
					id: string;
					project: {
						mergeRequest: GitLabMergeRequest;
					};
				};
			};
		};

		// find the nested node/note
		const addedNode = response.createNote.note.project.mergeRequest.discussions.nodes.find(
			(_: any) => {
				return _.notes.nodes.find((n: any) => n.id === response.createNote.note.id);
			}
		);

		const result: Directives = {
			directives: [
				{
					type: "updatePullRequest",
					data: {
						updatedAt: response.createNote.note.project.mergeRequest.updatedAt
					}
				}
			]
		};

		if (addedNode) {
			this.ensureAvatarAbsolutePathRecurse(addedNode);
			result.directives.push({
				type: "addNode",
				data: addedNode
			});
		}

		return result;
	}

	async resolveReviewThread(request: {
		id: string;
		onOff: boolean;
		type: string;
		pullRequestId: string;
	}): Promise<Directives | undefined> {
		const noteId = request.id;
		const response = await this.mutate<any>(
			`
		mutation DiscussionToggleResolve($id:ID!, $resolve: Boolean!) {
			discussionToggleResolve(input:{id:$id, resolve:$resolve}) {
				  clientMutationId
					  discussion {
						id
						resolvedAt
						resolved
						resolvable
						resolvedBy {
							  login: username
							  avatarUrl
						}
						notes {
							nodes {
							  id
							  resolvable
							  resolved
							}
						}
					  }
				  }
			  }`,
			{
				id: noteId,
				resolve: request.onOff
			}
		);

		return {
			directives: [
				{
					type: "updateNode",
					data: response.discussionToggleResolve.discussion
				}
			]
		};
	}

	@log()
	async deletePullRequestComment(request: {
		id: string;
		type: string;
		isPending: boolean;
		pullRequestId: string;
	}): Promise<Directives | undefined> {
		const noteId = request.id;
		const { id, iid, projectFullPath } = this.parseId(request.pullRequestId);

		if (request.isPending) {
			await this.gitLabReviewStore.deleteComment(new GitLabId(projectFullPath, iid), request.id);
		} else {
			const query = `
				mutation DestroyNote($id:ID!) {
					destroyNote(input:{id:$id}) {
			  			clientMutationId
			  				note {
								id
			  				}
						}
		  			}`;

			await this.mutate<any>(query, {
				id: noteId
			});
		}
		this._pullRequestCache.delete(id);
		this.session.agent.sendNotification(DidChangePullRequestCommentsNotificationType, {
			pullRequestId: id,
			commentId: noteId
		});

		return {
			directives: [
				{
					type: "removeNode",
					data: {
						id: request.id
					}
				}
			]
		};
	}

	@log()
	async createPullRequestCommentAndClose(request: {
		pullRequestId: string;
		text: string;
		startThread: boolean;
	}) {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);
		let directives: any = [];

		if (request.text) {
			if (request.startThread) {
				const response1 = await this.createPullRequestThread({ ...request });
				if (response1.directives) {
					directives = directives.concat(response1.directives);
				}
			} else {
				const response1 = await this.createPullRequestComment({ ...request, iid: iid });
				if (response1.directives) {
					directives = directives.concat(response1.directives);
				}
			}
		}

		// https://docs.gitlab.com/ee/api/merge_requests.html#update-mr
		const mergeRequestUpdatedResponse = await this.restPut<
			{ state_event: string },
			{
				merge_status: string;
				merged_at: any;
				created_at: string;
				state: string;
				updated_at: any;
				closed_at: any;
				closed_by: any;
			}
		>(`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}`, {
			state_event: "close"
		});

		const body = mergeRequestUpdatedResponse.body;
		directives.push({
			type: "updatePullRequest",
			data: {
				mergedAt: body.merged_at,
				mergeStatus: body.merge_status,
				state: body.state,
				updatedAt: body.updated_at,
				closedAt: body.closed_at,
				closedBy: body.closed_by
			}
		});

		directives.push({
			type: "addNodes",
			data: await this.getStateEvents(projectFullPath, iid)
		});

		return {
			directives: directives
		};
	}

	@log()
	async createPullRequestCommentAndReopen(request: {
		pullRequestId: string;
		text: string;
		startThread: boolean;
	}): Promise<any> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		let directives: any = [];

		if (request.text) {
			if (request.startThread) {
				const response1 = await this.createPullRequestThread({ ...request });
				if (response1.directives) {
					directives = directives.concat(response1.directives);
				}
			} else {
				const response1 = await this.createPullRequestComment({ ...request, iid: iid });
				if (response1.directives) {
					directives = directives.concat(response1.directives);
				}
			}
		}

		// https://docs.gitlab.com/ee/api/merge_requests.html#update-mr
		const mergeRequestUpdatedResponse = await this.restPut<
			{ state_event: string },
			{
				merged_at: any;
				merge_status: string;
				state: string;
				updated_at: any;
				closed_at: any;
				closed_by: any;
				created_at: any;
			}
		>(`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}`, {
			state_event: "reopen"
		});

		const body = mergeRequestUpdatedResponse.body;
		directives.push({
			type: "updatePullRequest",
			data: {
				mergedAt: body.merged_at,
				mergeStatus: body.merge_status,
				state: body.state,
				updatedAt: body.updated_at,
				closedAt: body.closed_at,
				closedBy: body.closed_by
			}
		});
		directives.push({
			type: "addNodes",
			data: await this.getStateEvents(projectFullPath, iid)
		});

		return {
			directives: directives
		};
	}

	@log()
	async getPullRequestCommits(
		request: FetchThirdPartyPullRequestCommitsRequest
	): Promise<FetchThirdPartyPullRequestCommitsResponse[]> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		const projectFullPathEncoded = encodeURIComponent(projectFullPath);
		const url = `/projects/${projectFullPathEncoded}/merge_requests/${iid}/commits`;
		const query = await this.restGet<
			{
				author_email: string;
				author_name: string;
				authored_date: string;
				committed_date: string;
				committer_email: string;
				committer_name: string;
				created_at: string;
				id: string;
				message: string;
				parent_ids?: string[];
				short_id: string;
				title: string;
				web_url: string;
			}[]
		>(url);

		return query.body.map(_ => {
			const authorAvatarUrl = Strings.toGravatar(_.author_email);
			let commiterAvatarUrl = authorAvatarUrl;
			if (_.author_email !== _.committer_email) {
				commiterAvatarUrl = Strings.toGravatar(_.committer_email);
			}
			return {
				oid: _.id,
				abbreviatedOid: _.short_id,
				author: {
					name: _.author_name,
					avatarUrl: authorAvatarUrl,
					user: {
						login: _.author_name
					}
				},
				committer: {
					name: _.committer_name,
					avatarUrl: commiterAvatarUrl,
					user: {
						login: _.committer_name
					}
				},
				message: _.message,
				authoredDate: _.authored_date,
				url: _.web_url
			};
		});
	}

	_pullRequestIdCache: Map<
		string,
		{
			pullRequestNumber: number;
			name: string;
			owner: string;
		}
	> = new Map<
		string,
		{
			pullRequestNumber: number;
			name: string;
			owner: string;
		}
	>();

	@log()
	async toggleMilestoneOnPullRequest(request: {
		pullRequestId: string;
		milestoneId: string;
	}): Promise<Directives | undefined> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		try {
			const response = await this.restPut<{ name: string }, any>(
				`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}`,
				{
					milestone_id: request.milestoneId
				}
			);
			return {
				directives: [
					{
						type: "updatePullRequest",
						data: {
							milestone: response.body.milestone
						}
					}
				]
			};
		} catch (err) {
			Logger.error(err);
			debugger;
		}
		return undefined;
	}

	@log()
	async setWorkInProgressOnPullRequest(request: {
		pullRequestId: string;
		onOff: boolean;
	}): Promise<Directives | undefined> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		try {
			const response = await this.mutate<any>(
				`mutation MergeRequestSetWip($projectPath: ID!, $iid: String!, $wip: Boolean!) {
					mergeRequestSetWip(input: {projectPath: $projectPath, iid: $iid, wip: $wip}) {
					  mergeRequest {
						title
						workInProgress
					  }
					}
				  }
				  `,
				{
					projectPath: projectFullPath,
					iid: iid,
					wip: request.onOff
				}
			);

			return {
				directives: [
					{
						type: "updatePullRequest",
						data: {
							workInProgress: response.mergeRequestSetWip.mergeRequest.workInProgress,
							title: response.mergeRequestSetWip.mergeRequest.title
						}
					}
				]
			};
		} catch (err) {
			Logger.error(err);
			debugger;
		}
		return undefined;
	}

	@log()
	async setLabelOnPullRequest(request: {
		pullRequestId: string;
		labelIds: string[];
		onOff: boolean;
	}): Promise<Directives | undefined> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		try {
			const response = await this.mutate<any>(
				`mutation MergeRequestSetLabels($projectPath: ID!, $iid: String!, $labelIds: [LabelID!]!) {
					mergeRequestSetLabels(input: {projectPath: $projectPath, iid: $iid, labelIds: $labelIds}) {
					  mergeRequest {
						labels(last: 100) {
						  nodes {
							id
							color
							title
						  }
						}
					  }
					}
				  }
				  `,
				{
					projectPath: projectFullPath,
					iid: iid,
					labelIds: request.labelIds
				}
			);

			return {
				directives: [
					{
						type: "setLabels",
						data: response.mergeRequestSetLabels.mergeRequest.labels
					},
					{
						type: "addNodes",
						data: await this.getLabelEvents(projectFullPath, iid)
					}
				]
			};
		} catch (err) {
			Logger.error(err);
			debugger;
		}
		return undefined;
	}

	@log()
	async toggleReaction(request: {
		pullRequestId: string;
		subjectId: string;
		content: string;
		onOff: boolean;
		id?: string;
	}): Promise<Directives | undefined> {
		const { projectFullPath, iid, id } = this.parseId(request.pullRequestId);

		try {
			let url = `/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}`;
			if (request.subjectId && request.subjectId != id) url += `/notes/${request.subjectId}`;
			url += "/award_emoji";

			if (request.onOff) {
				const response = await this.restPost<{ name: string }, any>(`${url}`, {
					name: request.content
				});
				response.body.user.login = response.body.user.username;
				response.body.user.avatarUrl = this.avatarUrl(response.body.user.avatar_url);
				return {
					directives: [
						{
							// FIXME -- if the subjectId is a note, update the note
							type: "addReaction",
							data: response.body
						}
					]
				};
			} else {
				if (!request.id) throw new Error("MissingId");

				// with DELETEs we don't get a JSON response
				const response = await this.restDelete<String>(`${url}/${request.id}`, {
					useRawResponse: true
				});
				if (response.body === "") {
					const currentUser = await this.getCurrentUser();
					return {
						directives: [
							{
								// FIXME -- if the subjectId is a note, update the note
								type: "removeReaction",
								data: {
									content: request.content,
									login: currentUser?.login
								}
							}
						]
					};
				}
			}
		} catch (err) {
			Logger.error(err);
			debugger;
		}
		return undefined;
	}

	@log()
	async getPullRequestFilesChanged(request: {
		pullRequestId: string;
	}): Promise<FetchThirdPartyPullRequestFilesResponse[]> {
		// https://developer.github.com/v3/pulls/#list-pull-requests-files
		const changedFiles: FetchThirdPartyPullRequestFilesResponse[] = [];
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		try {
			const url: string | undefined = `/projects/${encodeURIComponent(
				projectFullPath
			)}/merge_requests/${iid}/changes`;

			const apiResponse = await this.restGet<{
				diff_refs: {
					base_sha: string;
					head_sha: string;
					start_sha: string;
				};
				changes: {
					sha: string;
					old_path: string;
					new_path: string;
					diff?: string;
				}[];
			}>(url);
			const mappped: FetchThirdPartyPullRequestFilesResponse[] = apiResponse.body.changes.map(_ => {
				return {
					sha: _.sha,
					status: "",
					additions: 0,
					changes: 0,
					deletions: 0,
					filename: _.new_path,
					patch: _.diff,
					diffRefs: apiResponse.body.diff_refs
				};
			});
			changedFiles.push(...mappped);
		} catch (err) {
			Logger.error(err);
			debugger;
		}

		return changedFiles;
	}

	@log()
	async cancelMergeWhenPipelineSucceeds(request: {
		pullRequestId: string;
	}): Promise<Directives | undefined> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		const response = await this.restPost<any, any>(
			`/projects/${encodeURIComponent(
				projectFullPath
			)}/merge_requests/${iid}/cancel_merge_when_pipeline_succeeds`,
			{}
		);
		Logger.log(`cancelMergeWhenPipelineSucceeds:${JSON.stringify(response.body)}`);
		return {
			directives: [
				{
					type: "updatePullRequest",
					data: {
						mergeWhenPipelineSucceeds: false
					}
				}
			]
		};
	}

	@log()
	async mergePullRequest(request: {
		pullRequestId: string;
		message: string;
		deleteSourceBranch?: boolean;
		squashCommits?: boolean;
		mergeWhenPipelineSucceeds?: boolean;
		includeMergeRequestDescription: boolean;
	}): Promise<Directives | undefined> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		try {
			const mergeResponse = await this.restPut<any, any>(
				`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/merge`,
				{
					merge_commit_message: request.message,
					squash: request.squashCommits,
					merge_when_pipeline_succeeds: request.mergeWhenPipelineSucceeds,
					should_remove_source_branch: request.deleteSourceBranch
				}
			);

			const response: Directives = {
				directives: [
					{
						type: "addNodes",
						data: await this.getStateEvents(projectFullPath, iid)
					}
				]
			};

			if (mergeResponse.body.merge_when_pipeline_succeeds) {
				// only updating the future state..
				response.directives.push({
					type: "updatePullRequest",
					data: {
						state: mergeResponse.body.state,
						mergeWhenPipelineSucceeds: mergeResponse.body.merge_when_pipeline_succeeds,
						updatedAt: mergeResponse.body.updated_at
					}
				});
			} else {
				response.directives.push({
					type: "updatePullRequest",
					data: {
						merged: true,
						state: mergeResponse.body.state,
						mergedAt: mergeResponse.body.merged_at,
						updatedAt: mergeResponse.body.updated_at
					}
				});
			}
			return response;
		} catch (ex) {
			Logger.warn(ex.message, ex);
			throw new Error("Failed to accept merge request.");
		}
	}

	@log()
	async createPullRequestInlineComment(request: {
		pullRequestId: string;
		text: string;
		sha?: string;
		leftSha: string;
		rightSha: string;
		filePath: string;
		oldLineNumber?: number | undefined;
		startLine: number;
		position?: number;
		metadata?: any;
	}) {
		const result = await this.createCommitComment({
			...request,
			path: request.filePath,
			sha: request.sha || request.rightSha
		});
		return result;
	}

	@log()
	async createCommitComment(request: {
		pullRequestId: string;
		// leftSha
		leftSha: string;
		// rightSha
		sha: string;
		text: string;
		path: string;
		oldLineNumber?: number | undefined;
		startLine?: number | undefined;
		// use endLine for multi-line comments
		endLine?: number;
		// used for old servers
		position?: number;
		metadata?: {
			contents: string;
			fileWithUrl: string;
			startLine: number;
			endLine: number;
		};
	}) {
		let projectFullPath, id, iid;
		try {
			({ projectFullPath, id, iid } = this.parseId(request.pullRequestId));

			const payload = {
				body: request.text,
				position: {
					base_sha: request.leftSha,
					head_sha: request.sha,
					start_sha: request.leftSha,
					position_type: "text",
					new_path: request.path,
					new_line: request.startLine
				}
			};

			if (request.oldLineNumber != null) {
				// seems related to this https://gitlab.com/gitlab-org/gitlab/-/issues/281143
				(payload.position as any).old_line = request.oldLineNumber;
			}

			Logger.log(`createCommitComment project=${projectFullPath} iid=${iid}`, {
				payload: payload
			});
			// https://docs.gitlab.com/ee/api/discussions.html#create-new-merge-request-thread
			const data = await this.restPost<any, any>(
				`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/discussions`,
				payload
			);

			this._pullRequestCache.delete(id);
			this.session.agent.sendNotification(DidChangePullRequestCommentsNotificationType, {
				pullRequestId: id
			});

			return data.body;
		} catch (ex) {
			// lines that are _slightly_ outside the context of a diff (yet are still in the hunks)
			// are not allowed and they return a bizzare error message...
			// retry as a comment not attached to a line of code
			if (ex?.message?.indexOf("must be a valid line code") > -1) {
				Logger.warn(`createCommitCommentLineCodeError`, {
					request: request,
					error: ex
				});
				const metadata = request.metadata;
				if (metadata) {
					return this.addComment({
						subjectId: request.pullRequestId,
						text: `${request.text || ""}\n\n\`\`\`\n${metadata.contents}\n\`\`\`
						\n${metadata.fileWithUrl} (Line${
							metadata.startLine === metadata.endLine
								? ` ${metadata.startLine}`
								: `s ${metadata.startLine}-${metadata.endLine}`
						})`
					});
				} else {
					return this.addComment({
						subjectId: request.pullRequestId,
						text: request.text
					});
				}
			} else {
				Logger.error(ex, `createCommitComment`, {
					request: request
				});

				throw ex;
			}
		}
	}

	@log()
	public async togglePullRequestApproval(request: {
		pullRequestId: string;
		approve: boolean;
	}): Promise<Directives | undefined> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		let response;
		const type: any = request.approve ? "addApprovedBy" : "removeApprovedBy";

		// NOTE there's no graphql for these
		if (request.approve) {
			response = await this.restPost<any, any>(
				`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/approve`,
				{}
			);
		} else {
			try {
				response = await this.restPost<any, any>(
					`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/unapprove`,
					{}
				);
			} catch (ex) {
				// this will throw a 404 error if it's alreay been unapproved
				// but you can approve many times. just ignore it.
				Logger.warn(ex.message);
			}
		}

		const lastDiscussions = await this.getLastDiscussions(projectFullPath, iid);
		return {
			directives: [
				{
					type: "addNodes",
					data: lastDiscussions
				},
				{
					type: type,
					data:
						response &&
						response.body.approved_by.map(
							(_: { user: { avatar_url: string; username: string; name: string } }) => {
								return {
									avatarUrl: this.avatarUrl(_.user.avatar_url),
									login: _.user.username,
									name: _.user.name
								};
							}
						)
				}
			]
		};
	}

	@log()
	async deletePullRequestReview(request: {
		pullRequestId: string;
		pullRequestReviewId: string;
	}): Promise<any> {
		const { id, iid, projectFullPath } = this.parseId(request.pullRequestId);

		await this.gitLabReviewStore.deleteReview(new GitLabId(projectFullPath, iid));

		this._pullRequestCache.delete(id);
		this.session.agent.sendNotification(DidChangePullRequestCommentsNotificationType, {
			pullRequestId: id
		});
		return true;
	}

	async getPullRequestIdFromUrl(request: { url: string }) {
		// since we only the url for the PR -- parse it out for the
		// data we need.
		const uri = URI.parse(request.url);
		const path = uri.path.split("/");
		let id = [];
		// both are valid
		// http://gitlab.codestream.us/my-group/my-subgroup/baz/-/merge_requests/1
		// http://gitlab.codestream.us/project/repo/-/merge_requests/1
		for (let i = 0; i < path.length; i++) {
			const current = path[i];
			if (!current) continue;
			if (current === "-") break;
			id.push(current);
		}

		const iid = path[path.length - 1];
		const fullPath = id.join("/");
		const pullRequestInfo = await this.query<any>(
			`query getId($fullPath: ID!, $iid: String!) {
				project(fullPath: $fullPath) {
				  webUrl
				  name
				  mergeRequest(iid: $iid) {
					id
				  }
				}
			  }
			  `,
			{
				fullPath: fullPath,
				iid: iid
			}
		);
		try {
			return JSON.stringify({
				full: `${fullPath}!${iid}`,
				id: this.fromMergeRequestGid(pullRequestInfo.project.mergeRequest.id)
			});
		} catch (ex) {
			Logger.warn(ex);
			throw ex;
		}
	}

	@log()
	async updateIssueComment(request: { id: string; body: string }): Promise<Directives> {
		const response = await this.mutate<any>(
			`mutation UpdateNote($id: NoteID!, $body: String!) {
			updateNote(input: {id: $id, body: $body}) {
			  clientMutationId
			  note {
				updatedAt
				body
				bodyHtml
				id
				discussion {
       			 id
      			}
			  }
			}
		  }
		  `,
			{
				id: request.id,
				body: request.body
			}
		);

		return {
			directives: [
				{
					type: "updateDiscussionNote",
					data: response.updateNote.note
				}
			]
		};
	}

	async getPullRequestLastUpdated(request: { pullRequestId: string }) {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		const response = await this.query<any>(
			` 
			query GetUpdatedAt($fullPath: ID!, $iid: String!) {
				project(fullPath: $fullPath) {		 
					mergeRequest(iid: $iid) {
						updatedAt 
					}
				}
			}
			`,
			{
				fullPath: projectFullPath,
				iid: iid
			}
		);

		return {
			updatedAt: response?.project?.mergeRequest?.updatedAt
		};
	}

	private async getLastDiscussions(projectFullPath: string, iid: string, last: number = 3) {
		const lastDiscussions = ((await this.query(print(mergeRequestDiscussionQuery), {
			fullPath: projectFullPath,
			iid: iid.toString(),
			last: last
		})) as GitLabMergeRequestWrapper).project?.mergeRequest.discussions.nodes;
		return lastDiscussions;
	}

	private async getMilestoneEvents(
		projectFullPath: string,
		iid: string
	): Promise<DiscussionNode[]> {
		return this._paginateRestResponse(
			`/projects/${encodeURIComponent(
				projectFullPath
			)}/merge_requests/${iid}/resource_milestone_events`,
			data => {
				return data.map(_ => {
					return {
						id: _.id,
						createdAt: _.created_at,
						notes: {
							nodes: [
								{
									createdAt: _.created_at,
									system: true,
									systemNoteIconName: `milestone-${_.action}`,
									author: this.fromRestUser(_.user),
									body: `${_.action === "add" ? "added" : "removed"}`,
									milestone: {
										title: _.milestone.title,
										url: _.milestone.web_url
									}
								}
							]
						}
					};
				});
			}
		);
	}

	private async getLabelEvents(projectFullPath: string, iid: string): Promise<DiscussionNode[]> {
		return this._paginateRestResponse(
			`/projects/${encodeURIComponent(
				projectFullPath
			)}/merge_requests/${iid}/resource_label_events`,
			data => {
				return data
					.filter(_ => _.label)
					.map(_ => {
						return {
							id: _.id,
							createdAt: _.created_at,
							notes: {
								nodes: [
									{
										createdAt: _.created_at,
										system: true,
										systemNoteIconName: `label-${_.action}`,
										author: this.fromRestUser(_.user),
										body: `${_.action === "add" ? "added" : "removed"}`,
										label: {
											description: _.label.description,
											color: _.label.color,
											title: _.label.name
										}
									}
								]
							}
						};
					});
			}
		);
	}

	private async getStateEvents(projectFullPath: string, iid: string): Promise<DiscussionNode[]> {
		return this._paginateRestResponse(
			`/projects/${encodeURIComponent(
				projectFullPath
			)}/merge_requests/${iid}/resource_state_events`,
			data => {
				return data.map(_ => {
					return {
						id: _.id,
						createdAt: _.created_at,
						notes: {
							nodes: [
								{
									createdAt: _.created_at,
									system: true,
									systemNoteIconName: `merge-request-${_.state}`,
									author: this.fromRestUser(_.user),
									body: _.state
								}
							]
						}
					};
				});
			}
		);
	}

	private avatarUrl(url: string) {
		return url?.startsWith("/") ? `${this.baseWebUrl}${url}` : url;
	}

	private fromRestUser(user: { [key: string]: any }) {
		user.login = user.username;
		user.avatarUrl = this.avatarUrl(user.avatar_url);
		delete user.username;
		delete user.avatar_url;
		return user;
	}

	private toKeyValuePair(q: string, currentUser: GitLabCurrentUser) {
		const kvp = q.split(":");
		let value = kvp[1];
		if (value === "@me" && currentUser) {
			value = currentUser.login;
		}
		return `${encodeURIComponent(kvp[0])}=${encodeURIComponent(value)}`;
	}

	private toMergeRequestGid(id: string) {
		return `gid://gitlab/MergeRequest/${id}`;
	}

	private fromMergeRequestGid(gid: string) {
		return gid.replace("gid://gitlab/MergeRequest/", "");
	}

	private toAuthorAbsolutePath(author: any): GitLabCurrentUser {
		if (author?.avatarUrl.indexOf("/") === 0) {
			// no really great way to handle this...
			author.avatarUrl = `${this.baseWebUrl}${author.avatarUrl}`;
		}
		return author;
	}

	private ensureAvatarAbsolutePathRecurse(obj: any) {
		if (!obj) return;
		for (const k in obj) {
			if (typeof obj[k] === "object") {
				this.ensureAvatarAbsolutePathRecurse(obj[k]);
			} else if (k === "avatarUrl") {
				if (obj.avatarUrl.indexOf("/") === 0) {
					obj.avatarUrl = `${this.baseWebUrl}${obj.avatarUrl}`;
				}
			}
		}
	}

	private async _paginateRestResponse(url: string, map: (data: any[]) => any[]) {
		let page: string | null = "1";
		let results: any[] = [];

		// url is only a path here and need this scheme for parsing
		const parsed = new nodeUrl.URL(url, "codestream://");

		while (true) {
			parsed.searchParams.set("page", page);
			const requestUrl = `${parsed.pathname}?${parsed.searchParams.toString()}&per_page=100`;
			const response = await this.restGet<any>(requestUrl);
			results = results.concat(map(response.body as any[]));
			// Logger.warn("RESPONSE: " + JSON.stringify(response.body, null, 4));
			const nextPage = response.response.headers.get("x-next-page");
			if (nextPage === page || !nextPage) {
				break;
				// } else if (parseInt(page, 10) > 10) {
				// 	break;
			} else {
				page = nextPage;
			}
		}
		return results;
	}
}

interface GitLabReview {
	version: string;
	comments: any[];
}

class GitLabId {
	constructor(private projectFullPath: string, private iid: string) {}

	/**
	 * creates a file-system safe path string
	 *
	 * @return {*}
	 * @memberof GitLabId
	 */
	asString() {
		return `${this.projectFullPath.replace(/\//g, "-")}-${this.iid}`.toLocaleLowerCase();
	}
}

class GitLabReviewStore {
	private path: string = "gitlab-review";
	private version: string = "1.0.0";

	private buildPath(id: GitLabId) {
		return this.path + "-" + id.asString() + ".json";
	}

	async add(id: GitLabId, comment: any) {
		try {
			const { textFiles } = SessionContainer.instance();
			const path = this.buildPath(id);
			const current = (
				await textFiles.readTextFile({
					path: path
				})
			)?.contents;
			const data = JSON.parse(current || "{}") || ({} as GitLabReview);
			comment = { ...comment, id: new Date().getTime().toString() };
			if (data && data.comments) {
				data.comments.push(comment);
			} else {
				data.version = this.version;
				data.comments = [comment];
			}
			await textFiles.writeTextFile({
				path: path,
				contents: JSON.stringify(data)
			});

			return true;
		} catch (ex) {
			Logger.error(ex);
		}
		return false;
	}

	async get(id: GitLabId): Promise<GitLabReview | undefined> {
		try {
			const { textFiles } = SessionContainer.instance();
			const path = this.buildPath(id);
			const current = (
				await textFiles.readTextFile({
					path: path
				})
			)?.contents;
			const data = JSON.parse(current || "{}") as GitLabReview;
			return data;
		} catch (ex) {
			Logger.error(ex);
		}
		return undefined;
	}

	async exists(id: GitLabId) {
		try {
			const { textFiles } = SessionContainer.instance();
			const path = this.buildPath(id);
			const data = await textFiles.readTextFile({
				path: path
			});
			if (!data || !data.contents) return false;

			const review = JSON.parse(data.contents || "{}") as GitLabReview;
			return review?.comments?.length > 0;
		} catch (ex) {
			Logger.error(ex);
		}
		return undefined;
	}

	updateComment() {
		// TODO
	}

	async deleteReview(id: GitLabId) {
		try {
			const { textFiles } = SessionContainer.instance();
			const path = this.buildPath(id);
			await textFiles.deleteTextFile({
				path: path
			});

			return true;
		} catch (ex) {
			Logger.error(ex);
		}
		return false;
	}

	async deleteComment(id: GitLabId, commentId: string) {
		const review = await this.get(id);
		if (review) {
			review.comments = review.comments.filter(_ => _.id !== commentId);
			if (review.comments.length) {
				const { textFiles } = SessionContainer.instance();
				const path = this.buildPath(id);
				await textFiles.writeTextFile({
					path: path,
					contents: JSON.stringify(review)
				});
			} else {
				// we aren't left with any comments.. just delete the file
				await this.deleteReview(id);
			}
		}

		return true;
	}

	mapToDiscussionNode(_: any, user: GitLabCurrentUser): DiscussionNode {
		const id = (_.id || new Date().getTime()).toString();
		return {
			_pending: true,
			id: id,
			createdAt: _.createdAt,
			resolved: false,
			resolvable: false,
			notes: {
				nodes: [
					{
						_pending: true,
						id: id,
						author: {
							name: user.name,
							login: user.login,
							avatarUrl: user.avatarUrl
						},
						resolved: false,
						resolvable: true,
						systemNoteIconName: "",
						discussion: {
							id: _.createdAt
						},
						state: "PENDING",
						body: _.text,
						bodyText: _.text,
						createdAt: _.createdAt,
						position: {
							oldLine: _.oldLineNumber,
							oldPath: _.filePath,
							newPath: _.filePath,
							newLine: _.startLine
						}
					}
				]
			}
		};
	}
}

interface GitLabPullRequest {
	id: number;
	iid: number;
	number: number;
	title: string;
	web_url: string;
	state: string;
	target_branch: string;
	source_branch: string;
	references?: {
		short: string;
		relative: string;
		full: string;
	};
}

interface GitLabPullRequestComment {
	id: number;
	type: string;
	body: string;
	attachment?: any;
	author: GitLabPullRequestCommentAuthor;
	created_at: string;
	updated_at: string;
	system: boolean;
	noteable_id: number;
	noteable_type: string;
	position: GitLabPullRequestCommentPosition;
	resolvable: boolean;
	resolved: boolean;
	resolved_by?: string;
	noteable_iid: number;
}

interface GitLabPullRequestCommentAuthor {
	id: number;
	name: string;
	login: string;
	state: string;
	avatar_url: string;
	web_url: string;
}

interface GitLabPullRequestCommentPosition {
	base_sha: string;
	start_sha: string;
	head_sha: string;
	old_path: string;
	new_path: string;
	position_type: string;
	old_line?: number;
	new_line: number;
	line_range: {
		start: {
			new_line: number;
		};
	};
}

interface GitLabCreateMergeRequestRequest {
	title: string;
	source_branch: string;
	target_branch: string;
	target_project_id?: string;
	description?: string;
}

interface GitLabCreateMergeRequestResponse {
	id: string;
	iid: string;
	title: string;
	reference: string;
	references: {
		full: string;
	};
	web_url: string;
}

interface GitLabProjectInfoResponse {
	iid: number;
	id: number;
	default_branch: string;
	forked_from_project: GitLabProject | undefined;
}

interface GitLabMergeRequestInfoResponse {
	iid: number;
	web_url: string;
	source_branch: string;
	target_branch: string;
	references: {
		full: string;
	};
}
