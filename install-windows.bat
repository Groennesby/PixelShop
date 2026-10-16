@echo off
setlocal
echo Installing PixelShop Studio Edition for Windows...
set "TARGET_DIR=%LOCALAPPDATA%\Programs\PixelShop"
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"

if exist "%~dp0PixelShop-Windows-x64\*" (
    xcopy /E /I /Y "%~dp0PixelShop-Windows-x64\*" "%TARGET_DIR%\" >nul
) else (
    xcopy /E /I /Y "%~dp0*" "%TARGET_DIR%\" >nul
)

set "SHORTCUT_SCRIPT=%TEMP%\make_pixelshop_shortcut.vbs"
echo Set oWS = WScript.CreateObject("WScript.Shell") > "%SHORTCUT_SCRIPT%"
echo sLinkFile = oWS.SpecialFolders("Desktop") ^& "\PixelShop.lnk" >> "%SHORTCUT_SCRIPT%"
echo Set oLink = oWS.CreateShortcut(sLinkFile) >> "%SHORTCUT_SCRIPT%"
echo oLink.TargetPath = "%TARGET_DIR%\PixelShop.exe" >> "%SHORTCUT_SCRIPT%"
echo oLink.WorkingDirectory = "%TARGET_DIR%" >> "%SHORTCUT_SCRIPT%"
echo oLink.IconLocation = "%TARGET_DIR%\icon.ico" >> "%SHORTCUT_SCRIPT%"
echo oLink.Description = "PixelShop Studio Edition" >> "%SHORTCUT_SCRIPT%"
echo oLink.Save >> "%SHORTCUT_SCRIPT%"
cscript //nologo "%SHORTCUT_SCRIPT%"
del "%SHORTCUT_SCRIPT%"

echo PixelShop installed successfully to %TARGET_DIR% and Desktop shortcut created!
start "" "%TARGET_DIR%\PixelShop.exe"
