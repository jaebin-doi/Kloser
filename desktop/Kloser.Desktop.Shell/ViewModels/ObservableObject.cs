// Phase 9 Step 4 — minimal INotifyPropertyChanged base.
//
// Hand-rolled instead of pulling CommunityToolkit.Mvvm. Step 4 view
// models are small and a 20-line base class keeps the dependency tree
// minimal. If Step 5/7 needs source generators, swap then.

using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace Kloser.Desktop.Shell.ViewModels;

public abstract class ObservableObject : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    protected void OnPropertyChanged([CallerMemberName] string? propertyName = null)
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }

    protected bool SetField<T>(ref T field, T value, [CallerMemberName] string? propertyName = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        OnPropertyChanged(propertyName);
        return true;
    }
}
