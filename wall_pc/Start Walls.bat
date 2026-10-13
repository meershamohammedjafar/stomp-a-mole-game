@echo off
rem Stomp the Mole: the walls and the ceiling, on the wall PC.
rem Shows the game's wall page fullscreen (Edge kiosk) on the 4K screen. Stop it with Alt+F4.
rem
rem *** EDIT THE NEXT LINE: put the floor PC's IP address after the = sign (no spaces). ***
rem When the game starts on the floor PC, its window shows it: "Wall PC: open http://ADDRESS:PORT/room.html".
set FLOOR_PC=192.168.123.228
rem The game's port: the number after ADDRESS: in that line. Only change it if it is not 8080.
set GAME_PORT=8080

rem ---------- nothing to change below this line ----------
setlocal
set "FLOOR_PC=%FLOOR_PC: =%"
if not defined GAME_PORT set "GAME_PORT=8080"
set "GAME_PORT=%GAME_PORT: =%"
rem FLOOR_PC may also be given as ADDRESS:PORT (copied from the floor PC's line); then that port is used.
set "HOST=%FLOOR_PC%:%GAME_PORT%"
if not "%FLOOR_PC::=%"=="%FLOOR_PC%" set "HOST=%FLOOR_PC%"
set "PAGE=room.html"
if /i "%~1"=="test" set "PAGE=room.html?test=1"
set "URL=http://%HOST%/%PAGE%"

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" goto start_edge
set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" goto start_edge

echo.
echo   Microsoft Edge was not found on this PC, so the walls cannot be shown.
echo   Looked for msedge.exe in:
echo     %ProgramFiles(x86)%\Microsoft\Edge\Application
echo     %ProgramFiles%\Microsoft\Edge\Application
echo   Install Microsoft Edge, then double-click this file again.
echo.
pause
exit /b 1

:start_edge
rem Wait until the game answers: Edge would show an error page and not try again by itself.
rem (curl.exe comes with Windows 10 1803 and later; without it, Edge starts at once.)
where curl.exe >nul 2>nul || goto launch
set "WAITED="
:wait_for_game
curl.exe -s -f -o nul -m 3 "%URL%" && goto launch
if not defined WAITED (
  echo.
  echo   Waiting for the game on the floor PC: %URL%
  echo   Start the game there ^("Start Stomp the Mole.bat"^). The walls appear by themselves
  echo   when it runs. If this never ends, see "WAITING FOR THE GAME" in README.txt.
  echo   To give up, close this window.
  set "WAITED=1"
)
ping -n 3 127.0.0.1 >nul
goto wait_for_game

:launch
rem --window-position=0,0 puts the kiosk on the monitor whose top-left is the desktop origin,
rem where the signage layout's 2600 x 1820 division is.
start "" "%EDGE%" --kiosk "%URL%" --edge-kiosk-type=fullscreen --inprivate --disable-sync --no-first-run --no-default-browser-check --user-data-dir="%LOCALAPPDATA%\StompTheMoleWalls" --window-position=0,0 --force-device-scale-factor=1 --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --hide-crash-restore-bubble --noerrdialogs
exit /b 0
