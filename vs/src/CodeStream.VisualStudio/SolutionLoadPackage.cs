﻿using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Events;
using Microsoft.VisualStudio.Shell.Interop;
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace CodeStream.VisualStudio
{
    //[Guid("61eadc52-5677-4548-b273-08f1e6574f71")]
    //[PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    //[InstalledProductRegistration("Solution Load Sample", "Demonstrates use of solution load events", "1.0")]
    //// The following line will schedule the package to be initialized when a solution is being opened
    //[ProvideAutoLoad(VSConstants.UICONTEXT.SolutionOpening_string, PackageAutoLoadFlags.BackgroundLoad)]
    //public sealed class SolutionLoadPackage : AsyncPackage
    //{
    //    protected override async System.Threading.Tasks.Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
    //    {
    //        // Since this package might not be initialized until after a solution has finished loading,
    //        // we need to check if a solution has already been loaded and then handle it.
    //        bool isSolutionLoaded = await IsSolutionLoadedAsync();

    //        if (isSolutionLoaded)
    //        {
    //            HandleOpenSolution();
    //        }

    //        // Listen for subsequent solution events
    //        SolutionEvents.OnAfterOpenSolution += HandleOpenSolution;
    //    }

    //    private async Task<bool> IsSolutionLoadedAsync()
    //    {
    //        await JoinableTaskFactory.SwitchToMainThreadAsync();
    //        var solService = await GetServiceAsync(typeof(SVsSolution)) as IVsSolution;

    //        ErrorHandler.ThrowOnFailure(solService.GetProperty((int)__VSPROPID.VSPROPID_IsSolutionOpen, out object value));

    //        return value is bool isSolOpen && isSolOpen;
    //    }

    //    private void HandleOpenSolution(object sender = null, EventArgs e = null)
    //    {
    //        // Handle the open solution and try to do as much work
    //        // on a background thread as possible
    //    }
    //}
}
