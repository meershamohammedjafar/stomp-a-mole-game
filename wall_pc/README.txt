STOMP THE MOLE: WALLS AND CEILING (on the wall PC)
==================================================

This folder shows the game on the three walls and the ceiling. Nothing has to be
installed on this PC: it only uses Microsoft Edge. The game itself runs on the
floor PC, and this PC reads it over the network.

Files:
  Start Walls.bat          shows the walls and the ceiling (fullscreen)
  Wall Test Pattern.bat    shows a test picture to check the screen edges
  README.txt               this file


ONE-TIME SETUP: TELL THIS PC WHERE THE FLOOR PC IS
--------------------------------------------------
1. Start the game on the floor PC. Its black window shows a line like this:
       Wall PC: open http://192.168.123.228:8080/room.html
   The number after "http://" is the floor PC's address (here 192.168.123.228).
   The number after the next ":" is the game's port (here 8080, the usual one).
2. On this PC, right-click "Start Walls.bat" and choose "Edit"
   (on Windows 11: "Show more options", then "Edit"). Notepad opens.
3. Find the line
       set FLOOR_PC=192.168.123.228
   and change the number after the = sign to the floor PC's address. No spaces.
   If the port in step 1 is not 8080, also change the number on the line
       set GAME_PORT=8080
   just below it to that port. Save with Ctrl+S and close Notepad.
"Wall Test Pattern.bat" uses the same address and port, so there is nothing to change in it.
If the floor PC's address (or the game's port) ever changes, do this again.


EVERY DAY
---------
1. Start the game on the floor PC first ("Start Stomp the Mole.bat" there).
2. On this PC, pause the signage player's campaign.
3. Double-click "Start Walls.bat". The walls and the ceiling fill the screen.
   If the game is not running yet, a small black window says "Waiting for the game
   on the floor PC" instead, and the walls appear by themselves as soon as it runs.
4. Look at the real walls and the ceiling: they must show the game (wooden signboards,
   meadow and sky), not the campaign. If the campaign comes back on top, pause it again.
   While this PC shows the walls, the floor leaves its score band to them, even when the
   campaign hides them (see "IF THE WALLS CANNOT BE RELIED ON" below).
5. To stop: press Alt+F4 (hold Alt and press F4). Then restart the signage
   player if it should play again.

If the walls are already showing, close them with Alt+F4 before starting them again.
On the floor, the score band and the top 10 move to the walls while the walls are
showing, and come back on the floor when the walls are closed. That is normal.


CHECKING THE SCREEN EDGES (the test pattern)
--------------------------------------------
Double-click "Wall Test Pattern.bat". The ceiling, the left wall, the front wall and the
right wall each get their own colour, with their name, their size, a grid and a bright
border. On the real screens, check that:
* each name is on the right surface (the arrow on the ceiling points to the front wall),
* the bright border shows all the way round each surface, right up to its edges,
* no hatched grey shows anywhere (hatched grey is picture that belongs to no surface).
Take a photo of each surface if something is cut off, doubled or in the wrong place,
and send the photos in. Press Alt+F4 to close the test pattern.


IF THE WALLS SAY "WAITING FOR THE GAME..."
-----------------------------------------
The wall page is running but cannot reach the game. It keeps trying every second, so it
starts by itself as soon as the cause is fixed. Check, in this order:
1. The game is running on the floor PC: its black window is open and shows no error.
2. FLOOR_PC and GAME_PORT in "Start Walls.bat" match the "Wall PC: open http://..." line
   in the floor PC's black window (see ONE-TIME SETUP).
3. The network: on this PC, open Command Prompt and type
       ping 192.168.123.228
   (with the floor PC's address). It should answer "Reply from ...".
4. The firewall on the floor PC must let python.exe accept connections. Windows asks
   about that only ONCE, the first time python.exe uses the network (that may have been
   long ago, for example when tuio_floor_map.py ran), and never again. If the answer then
   was "no" (Cancel, or only "Private" ticked while the network is marked Public), Windows
   made rules that BLOCK python.exe, and a block rule wins over any allow rule. To fix it,
   on the floor PC, signed in as an administrator:
   a. See how its network is marked: Settings > Network & Internet > Wi-Fi (or Ethernet),
      click the network's name and look at "Network profile" (Public or Private).
      A new network (for example a network cable instead of Wi-Fi) can come up with a
      different profile, and Windows does not ask again.
   b. Press Windows+R, type  wf.msc  and press Enter. Click "Inbound Rules", then the
      "Name" column to sort it. Every rule named "python" or "python.exe" whose Action
      is "Block": right-click it and choose "Delete". (There may be several.)
   c. Start menu > "Allow an app through Windows Firewall" > "Change settings": tick
      both "Private" and "Public" for every "python" entry, then OK.
   d. Close the game and start it again.
   README.md on the floor PC (section "Firewall") has the same steps, and commands that
   do it in one go.
5. The floor PC's black window must not say "The walls cannot connect". If it does,
   the setting http.host in the floor PC's config.json must be changed back to "0.0.0.0".
A quick test from this PC: open Edge normally and go to
    http://192.168.123.228:8080/scoreboard.html   (with the floor PC's address)
If that page shows the game's phase and score, the network and the firewall are fine.


IF THE WALLS CANNOT BE RELIED ON
--------------------------------
While this PC shows the wall page, the floor leaves the score, the timer and the top 10
to the walls. If the walls cannot show the game for a while (the signage campaign has to
stay on top, or the wall screens are switched off while this PC runs), open the floor PC's
stomp_the_mole\config.json in Notepad and change the "hud" line to
    "hud":     {"show_on_floor": true, "rotation": 0},
then restart the game: the floor then always shows its own score band and top 10.
Change it back to "auto" (with the quotes) when the walls are back.


IF IT SAYS "MICROSOFT EDGE WAS NOT FOUND"
-----------------------------------------
Edge comes with Windows 10 and 11. If it was removed, install it again, then double-click
"Start Walls.bat" again.
