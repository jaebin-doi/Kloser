// Phase 9 Step 4 — small wrapper around the WPF Dispatcher so the
// capture loop (background thread) can post updates to view-model
// properties safely without referring to System.Windows.Application
// directly from every call site.

using System.Windows.Threading;

namespace Kloser.Desktop.Shell.Services;

public sealed class UiDispatcher
{
    private readonly Dispatcher _dispatcher;

    public UiDispatcher(Dispatcher dispatcher)
    {
        _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
    }

    public void Post(Action action)
    {
        if (_dispatcher.CheckAccess())
        {
            action();
        }
        else
        {
            _dispatcher.BeginInvoke(action);
        }
    }
}
