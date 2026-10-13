@echo off
node --disable-warning=ExperimentalWarning "%~dp0src\cli.mjs" %*
exit /b %errorlevel%
