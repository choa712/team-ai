@echo off
rem One-command TeamAI install for Windows. Starts install.ps1 whatever the
rem PowerShell execution policy is: under the default Restricted policy a .ps1
rem cannot be started directly. Arguments pass through, e.g. -Uninstall.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %ERRORLEVEL%
