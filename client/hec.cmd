@echo off
setlocal
set "RUNNER=%~dp0..\target\release\pi-hec-runner.exe"
if not exist "%RUNNER%" set "RUNNER=%USERPROFILE%\.pi-hec\bin\pi-hec-runner.exe"
if not exist "%RUNNER%" (
  echo pi-hec-runner.exe not found. Build native/runner or run client/bootstrap.ps1.
  exit /b 1
)
"%RUNNER%" attach %CD%
