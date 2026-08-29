Option Explicit

Dim shell, fileSystem, scriptDirectory, wrapperPath, powershellPath
Dim role, command, exitCode

If WScript.Arguments.Count <> 1 Then
    WScript.Quit 2
End If
role = UCase(WScript.Arguments(0))
If role <> "PRIMARY" And role <> "BACKUP" Then
    WScript.Quit 2
End If

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
wrapperPath = fileSystem.BuildPath(scriptDirectory, "run_kmem_update_hidden.ps1")
powershellPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
If Not fileSystem.FileExists(wrapperPath) Or Not fileSystem.FileExists(powershellPath) Then
    WScript.Quit 3
End If

command = QuoteArgument(powershellPath) _
    & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " _
    & QuoteArgument(wrapperPath) & " -Role " & role

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function QuoteArgument(value)
    QuoteArgument = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
