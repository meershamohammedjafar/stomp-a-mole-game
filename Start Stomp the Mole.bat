@echo off
rem Double-click to start Stomp the Mole. Keep Interactive Platform open; close tuio_floor_map first.
cd /d "%~dp0"
title Stomp the Mole server
python -m stomp_the_mole %*
pause
