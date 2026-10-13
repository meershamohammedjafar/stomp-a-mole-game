/* Stomp the Mole: scoreboard, a test view of the data feed (DESIGN.md "scoreboard.html").

   Shows everything the wall screens need (phase, countdown, time left, score, combo, best
   combo, the last event, today's top N) straight from the feed, plus which screens are
   connected. No sound.
*/
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    link: $('link'), phase: $('phase'), event: $('event'), timeCard: $('timeCard'), time: $('time'),
    score: $('score'), combo: $('combo'), best: $('best'), result: $('result'), extra: $('extra'),
    top: $('top'), countdown: $('countdown'), cdValue: $('cdValue'), connecting: $('connecting'),
    topTitle: $('topTitle'),
  };

  let config = null;
  let topN = 10;           // highscores.size from the hello config
  let warnS = 10;          // round.time_warning_s from the hello config
  let latest = null;
  let warning = false;     // a time_warning event arrived this round
  let tableKey = '';
  let shownCountdown = null;

  function setText(node, text) {
    text = String(text);
    if (node.textContent !== text) node.textContent = text;
  }

  function describe(ev) {
    switch (ev.name) {
      case 'hit': return 'hit (score ' + ev.score + ', combo ' + ev.combo + ')';
      case 'combo': return 'combo x' + ev.combo;
      case 'countdown': return 'countdown ' + ev.value;
      case 'time_warning': return 'time warning ' + ev.seconds_left + ' s';
      case 'round_end': return 'round end (score ' + ev.score + (ev.rank ? ', rank ' + ev.rank : '') + ')';
      case 'mole_up': return 'mole up (hole ' + ev.hole + ')';
      case 'escaped': return 'escaped (hole ' + ev.hole + ')';
      case 'empty_stomp': return 'empty stomp (hole ' + ev.hole + ')';
      case 'start_pad': return 'start pad';
      default: return ev.name;
    }
  }

  // Connected pages per role, counted by the server (e.g. "screens: floor 1, room 1").
  function screensText(screens) {
    if (!screens || typeof screens !== 'object') return '';
    const parts = Object.keys(screens).map((role) => role + ' ' + screens[role]);
    return '  screens: ' + (parts.length ? parts.join(', ') : 'none');
  }

  function renderTable(list, mine) {
    const key = JSON.stringify(list) + '|' + mine;
    if (key === tableKey) return;
    tableKey = key;
    el.top.textContent = '';
    if (!list.length) {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = 'No scores yet today';
      el.top.appendChild(p);
      return;
    }
    list.slice(0, topN).forEach((row, i) => {
      const li = document.createElement('li');
      if (mine === i + 1) li.className = 'mine';
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = i + 1;
      const score = document.createElement('span');
      score.textContent = row.score;
      const combo = document.createElement('span');
      combo.className = 'combo';
      combo.textContent = 'x' + row.best_combo;
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = row.time || '';
      li.append(rank, score, combo, when);
      el.top.appendChild(li);
    });
  }

  function render() {
    requestAnimationFrame(render);
    const st = latest;
    el.link.className = feed.connected ? 'up' : '';
    el.connecting.hidden = feed.received;
    if (!st) return;

    if (el.phase.textContent !== st.phase) {
      el.phase.textContent = st.phase;
      el.phase.className = 'pill ' + st.phase;
    }

    // time left: smooth from phase_end and the synced clock; full round outside play
    let secs;
    if (st.phase === 'play') {
      const left = typeof st.phase_end === 'number' ? st.phase_end - feed.serverNow() : st.time_left_ms || 0;
      secs = Math.max(0, Math.ceil(left / 1000));
    } else {
      secs = Math.round((st.round_ms || (config && config.round.play_ms) || 60000) / 1000);
    }
    setText(el.time, st.phase === 'results' ? 0 : secs);
    el.timeCard.classList.toggle('warn', st.phase === 'play' && (warning || secs <= warnS));

    setText(el.score, st.score);
    setText(el.combo, st.combo);
    setText(el.best, st.best_combo);

    const res = st.result;
    if (st.phase === 'results' && res) {
      setText(el.result, res.new_high ? 'NEW HIGH SCORE!' : res.rank ? 'Rank #' + res.rank + ' today' : 'Final score ' + res.score);
      el.result.classList.toggle('new', !!res.new_high);
    } else {
      setText(el.result, '');
    }
    setText(el.extra, 'hits ' + st.hits + '  misses ' + st.misses + '  escaped ' + st.escaped +
      '  level ' + Number(st.level || 0).toFixed(2) + (st.phase === 'attract' && st.start_progress > 0
        ? '  start pad ' + Math.round(st.start_progress * 100) + '%' : '')
      + (st.phase === 'attract' && st.start_blocked ? '  start pad: step off and back on' : '')
      + screensText(st.screens));

    const cd = st.countdown === undefined ? null : st.countdown;
    if (cd !== shownCountdown) {
      shownCountdown = cd;
      el.countdown.hidden = cd === null;
      el.countdown.classList.toggle('go', cd === 'GO');
      // a fresh span restarts the pop animation
      const span = document.createElement('span');
      span.textContent = cd === 'GO' ? 'GO!' : cd === null ? '' : String(cd);
      el.countdown.replaceChild(span, el.cdValue);
      el.cdValue = span;
    }

    renderTable(Array.isArray(st.highscores) ? st.highscores : [], st.phase === 'results' && res ? res.rank : null);
  }

  let flashTimer = 0;
  const feed = window.StompFeed.connect({
    onHello(msg) {
      config = msg.config || null;
      const hs = config && config.highscores;
      topN = hs && typeof hs.size === 'number' && hs.size >= 1 ? Math.round(hs.size) : 10;
      const round = config && config.round;
      warnS = round && typeof round.time_warning_s === 'number' ? round.time_warning_s : 10;
      setText(el.topTitle, "TODAY'S TOP " + topN);
      el.top.style.gridTemplateRows = 'repeat(' + topN + ', minmax(0, 1fr))';
      tableKey = '';   // redraw the table at the new length
    },
    onState(msg) {
      if (msg.phase === 'play' && latest && latest.phase !== 'play') warning = false;
      latest = msg;
    },
    onEvent(msg) {
      if (msg.name === 'time_warning') warning = true;
      if (msg.name === 'round_start') warning = false;
      el.event.innerHTML = 'last event: <b></b>';
      el.event.querySelector('b').textContent = describe(msg);
      el.event.classList.add('flash');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => el.event.classList.remove('flash'), 400);
    },
  });
  feed.sendClient('scoreboard', 'none');
  requestAnimationFrame(render);
})();
