@echo off
rem Stomp the Mole: the TEST PATTERN for the walls and the ceiling, on the wall PC.
rem Each surface shows its name, its size, a grid and a bright border, to check that the
rem ceiling and the three walls line up with the real screens. Stop it with Alt+F4.
rem
rem The floor PC's address is set in "Start Walls.bat" (edit it there, not here).
call "%~dp0Start Walls.bat" test
