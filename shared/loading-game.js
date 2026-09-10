// loading-game.js — a tiny, dependency-free drag-to-shoot basketball
// mini-game shown during the app's loading screens (passage generation,
// reading scoring, comprehension grading) so the wait feels shorter. Pure
// <canvas> + vanilla JS, no images/libraries — it injects its own <style>
// tag on first use, so it's a genuine drop-in component: any page can
// mount it without already having matching CSS loaded. The court, hoop
// and ball are all drawn with canvas primitives (no image assets), and
// the score chime is synthesized with the Web Audio API, keeping this a
// single, asset-free file.
//
// Usage:
//   const game = LoadingGame.mount(containerEl);
//   // ...later, as soon as the real content is ready...
//   game.destroy(); // stops the loop, removes listeners, removes the canvas
//
// Only one instance should be mounted at a time per page. dojo.html
// destroys the previous instance (if any) at the top of every render(),
// before the next screen — loading or not — takes over, so the game
// always stops the instant the real content finishes loading.

(function () {
  "use strict";

  var STYLE_ID = "loading-game-styles";
  var CSS =
    ".lg-wrap{position:relative;width:100%;}" +
    ".lg-canvas{display:block;width:100%;height:150px;background:#000;border-radius:8px;touch-action:none;cursor:pointer;}" +
    ".lg-hint{text-align:center;font-size:12px;color:#9a9a9a;margin-top:8px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;}";

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ---- Tunable constants (all physics is time-based — px per
  // millisecond — rather than per-frame, so the game plays at the same
  // speed and difficulty regardless of the device's actual frame rate) ----
  var GRAVITY = 0.0015; // px/ms^2, applied to vertical velocity each frame
  var POWER_SCALE = 0.01; // px/ms of launch speed per px of drag pull
  var MIN_DRAG = 10; // px — shorter drags are treated as a cancelled shot
  var MAX_DRAG = 90; // px — pulling further than this doesn't add more power
  var BALL_RADIUS = 8;
  var HOOP_RIGHT_MARGIN = 14; // backboard's distance from the canvas's right edge
  var BACKBOARD_WIDTH = 4;
  var BACKBOARD_TOP = 10;
  var BACKBOARD_HEIGHT = 32;
  var RIM_WIDTH = 34; // how far the rim sticks out to the left of the backboard
  var RIM_DROP = 6; // rim's distance below the top of the backboard
  var POST_RADIUS = 2.5; // collision radius of each rim tip
  var BOUNCE_RESTITUTION = 0.45; // velocity retained (and reflected) on a rim/backboard hit

  // ---- Court geometry: a simple trapezoid standing in for a full court
  // viewed end-on-ish, wide at the near (bottom) baseline and narrower at
  // the far (top) baseline. The hoop stands just beyond the court's right
  // edge, matching a real court where the basket overhangs the baseline. ----
  var COURT_TOP_Y = 22;
  var COURT_BOTTOM_MARGIN = 8;
  var COURT_TOP_LEFT_FRAC = 0.3;
  var COURT_TOP_RIGHT_FRAC = 0.66;
  var COURT_BOTTOM_LEFT_FRAC = 0.02;
  var COURT_BOTTOM_RIGHT_FRAC = 0.97;

  function mount(container) {
    ensureStyles();

    var wrap = document.createElement("div");
    wrap.className = "lg-wrap";
    var canvas = document.createElement("canvas");
    canvas.className = "lg-canvas";
    wrap.appendChild(canvas);
    var hint = document.createElement("div");
    hint.className = "lg-hint";
    hint.textContent = "Drag the ball to shoot";
    wrap.appendChild(hint);
    container.appendChild(wrap);

    var ctx = canvas.getContext("2d");

    // Court corners, recomputed on resize from the canvas's current CSS
    // size. courtXBoundsAtY() interpolates the left/right playing-floor
    // edge for any y between the far and near baselines.
    var courtTopY = COURT_TOP_Y;
    var courtBottomY = 120;
    var courtTopLeftX = 0;
    var courtTopRightX = 0;
    var courtBottomLeftX = 0;
    var courtBottomRightX = 0;

    // Canvas internal resolution follows its CSS box size (and device
    // pixel ratio) so drawing stays crisp without manually scaling shapes.
    function resize() {
      var rect = canvas.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      courtBottomY = rect.height - COURT_BOTTOM_MARGIN;
      courtTopY = COURT_TOP_Y;
      courtTopLeftX = rect.width * COURT_TOP_LEFT_FRAC;
      courtTopRightX = rect.width * COURT_TOP_RIGHT_FRAC;
      courtBottomLeftX = rect.width * COURT_BOTTOM_LEFT_FRAC;
      courtBottomRightX = rect.width * COURT_BOTTOM_RIGHT_FRAC;
    }

    function courtXBoundsAtY(y) {
      var span = courtBottomY - courtTopY;
      var t = span > 0 ? (y - courtTopY) / span : 0;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      return {
        left: courtTopLeftX + (courtBottomLeftX - courtTopLeftX) * t,
        right: courtTopRightX + (courtBottomRightX - courtTopRightX) * t,
      };
    }

    // Hoop geometry, derived from the canvas's current width so it holds
    // up across different container sizes. Recomputed on demand (cheap)
    // rather than cached, so a resize is reflected immediately.
    function hoopGeometry() {
      var w = canvas.getBoundingClientRect().width;
      var backboardX = w - HOOP_RIGHT_MARGIN - BACKBOARD_WIDTH;
      var rimY = BACKBOARD_TOP + RIM_DROP;
      return {
        backboardX: backboardX,
        backboardTop: BACKBOARD_TOP,
        backboardBottom: BACKBOARD_TOP + BACKBOARD_HEIGHT,
        rimY: rimY,
        rimLeftX: backboardX - RIM_WIDTH,
        rimRightX: backboardX,
      };
    }

    // ---- Game state ----
    var ball = { x: 60, y: 0, vx: 0, vy: 0 };
    var phase = "idle"; // 'idle' (resting, waiting for a drag) | 'aiming' | 'flying'
    var dragCurrent = { x: 0, y: 0 }; // live pointer position while aiming
    var scoredThisFlight = false;
    var score = 0;
    var hoopShakeMag = 0; // decays each frame after a rim/backboard hit
    var scorePopup = null; // { ageMs } — a rising "+1" shown briefly after a score
    var running = true; // false once destroy() runs, to stop the rAF loop
    var rafId = null;
    var lastTs = null;
    var audioCtx = null;
    // The ball can rest anywhere on the court, not just a fixed ground
    // line — so each shot remembers the floor height it launched from,
    // and "landing" means falling back to that same height.
    var flightFloorY = 0;

    // Picks a random resting spot anywhere on the court floor (avoiding
    // the hoop itself so the ball never respawns stuck under the rim).
    function respawnBall() {
      var hoop = hoopGeometry();
      var x = 0;
      var y = 0;
      var tries;
      for (tries = 0; tries < 12; tries++) {
        y = courtTopY + Math.random() * (courtBottomY - courtTopY);
        var bounds = courtXBoundsAtY(y);
        var usable = Math.max(1, bounds.right - bounds.left - BALL_RADIUS * 2);
        x = bounds.left + BALL_RADIUS + Math.random() * usable;
        var nearHoop = x > hoop.rimLeftX - 24 && y < hoop.backboardBottom + 20;
        if (!nearHoop) break;
      }
      ball.x = x;
      ball.y = y;
      ball.vx = 0;
      ball.vy = 0;
      phase = "idle";
    }

    // A short two-tone chime synthesized with the Web Audio API — no
    // embedded audio file needed. Wrapped defensively: audio is a nice-to
    // -have here and must never be able to break the game loop.
    function ensureAudioContext() {
      if (!audioCtx) {
        try {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
          audioCtx = null;
        }
      }
      if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume().catch(function () {});
      }
      return audioCtx;
    }

    function playScoreChime() {
      var ac = ensureAudioContext();
      if (!ac) return;
      try {
        var now = ac.currentTime;
        [660, 880].forEach(function (freq, i) {
          var osc = ac.createOscillator();
          var gain = ac.createGain();
          osc.type = "sine";
          osc.frequency.value = freq;
          var t0 = now + i * 0.09;
          gain.gain.setValueAtTime(0.0001, t0);
          gain.gain.linearRampToValueAtTime(0.15, t0 + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
          osc.connect(gain).connect(ac.destination);
          osc.start(t0);
          osc.stop(t0 + 0.22);
        });
      } catch (e) {
        // Ignore — never let a synthesis error interrupt the game.
      }
    }

    function distance(x1, y1, x2, y2) {
      var dx = x2 - x1;
      var dy = y2 - y1;
      return Math.sqrt(dx * dx + dy * dy);
    }

    // Reflects the ball's velocity off a point obstacle (a rim tip),
    // pushing it back outside the collision radius first so it doesn't
    // stick, then mirroring its velocity across the collision normal with
    // some energy loss (BOUNCE_RESTITUTION).
    function bounceOffPoint(px, py) {
      var dx = ball.x - px;
      var dy = ball.y - py;
      var dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
      var nx = dx / dist;
      var ny = dy / dist;
      var overlap = BALL_RADIUS + POST_RADIUS - dist;
      if (overlap > 0) {
        ball.x += nx * overlap;
        ball.y += ny * overlap;
      }
      var dot = ball.vx * nx + ball.vy * ny;
      ball.vx = (ball.vx - 2 * dot * nx) * BOUNCE_RESTITUTION;
      ball.vy = (ball.vy - 2 * dot * ny) * BOUNCE_RESTITUTION;
      hoopShakeMag = 1;
    }

    function updateFlying(dt, prevY) {
      var hoop = hoopGeometry();

      // Backboard: a thin vertical wall — bounce the ball back leftward
      // if it's overlapping it and still travelling toward it.
      var nearBackboardX =
        ball.x + BALL_RADIUS > hoop.backboardX &&
        ball.x - BALL_RADIUS < hoop.backboardX + BACKBOARD_WIDTH &&
        ball.y > hoop.backboardTop &&
        ball.y < hoop.backboardBottom;
      if (nearBackboardX && ball.vx > 0) {
        ball.x = hoop.backboardX - BALL_RADIUS;
        ball.vx = -ball.vx * BOUNCE_RESTITUTION;
        hoopShakeMag = 1;
      }

      // Rim tips — two small collision posts at each end of the rim opening.
      if (distance(ball.x, ball.y, hoop.rimLeftX, hoop.rimY) < BALL_RADIUS + POST_RADIUS) {
        bounceOffPoint(hoop.rimLeftX, hoop.rimY);
      } else if (distance(ball.x, ball.y, hoop.rimRightX, hoop.rimY) < BALL_RADIUS + POST_RADIUS) {
        bounceOffPoint(hoop.rimRightX, hoop.rimY);
      }

      // Scoring: the ball must have been above the rim last frame and at
      // or below it now, still moving downward, and pass through the
      // rim's horizontal opening (with a small margin so it has to be a
      // genuine "through the hoop," not just clipping a rim tip).
      var margin = BALL_RADIUS * 0.6;
      if (
        !scoredThisFlight &&
        prevY < hoop.rimY &&
        ball.y >= hoop.rimY &&
        ball.vy > 0 &&
        ball.x > hoop.rimLeftX + margin &&
        ball.x < hoop.rimRightX - margin
      ) {
        scoredThisFlight = true;
        score += 1;
        scorePopup = { ageMs: 0, x: (hoop.rimLeftX + hoop.rimRightX) / 2, y: hoop.rimY };
        playScoreChime();
      }

      // Floor: whatever happened above, once the ball falls back to the
      // height it launched from, the attempt is over — respawn it
      // somewhere fresh on the court.
      if (ball.y + BALL_RADIUS >= flightFloorY) {
        ball.y = flightFloorY - BALL_RADIUS;
        respawnBall();
      }
    }

    function update(dt) {
      if (hoopShakeMag > 0) {
        hoopShakeMag *= 0.85;
        if (hoopShakeMag < 0.02) hoopShakeMag = 0;
      }
      if (scorePopup) {
        scorePopup.ageMs += dt;
        if (scorePopup.ageMs > 700) scorePopup = null;
      }

      if (phase !== "flying") return;

      var prevY = ball.y;
      ball.vy += GRAVITY * dt;
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      updateFlying(dt, prevY);
    }

    function draw() {
      var rect = canvas.getBoundingClientRect();
      var w = rect.width;
      var h = rect.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);

      drawCourt();
      drawHoop();
      drawAimLine();
      drawBall();

      // Score
      ctx.fillStyle = "#f0f0f0";
      ctx.font = "600 13px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("Score: " + score, 10, 18);

      drawScorePopup();
    }

    function courtPath() {
      ctx.beginPath();
      ctx.moveTo(courtTopLeftX, courtTopY);
      ctx.lineTo(courtTopRightX, courtTopY);
      ctx.lineTo(courtBottomRightX, courtBottomY);
      ctx.lineTo(courtBottomLeftX, courtBottomY);
      ctx.closePath();
    }

    // A simplified wood court: a shaded trapezoid floor with a few plank
    // streaks, a border, a center circle, a halfway line and two small
    // key rectangles near the baselines — enough to read as a court at
    // this size without drawing every real marking.
    function drawCourt() {
      ctx.save();
      courtPath();
      var grad = ctx.createLinearGradient(0, courtTopY, 0, courtBottomY);
      grad.addColorStop(0, "#a97c49");
      grad.addColorStop(1, "#caa06c");
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.clip();

      ctx.strokeStyle = "rgba(0,0,0,0.08)";
      ctx.lineWidth = 1;
      var planks = 7;
      var i;
      for (i = 1; i < planks; i++) {
        var t = i / planks;
        var topX = courtTopLeftX + (courtTopRightX - courtTopLeftX) * t;
        var botX = courtBottomLeftX + (courtBottomRightX - courtBottomLeftX) * t;
        ctx.beginPath();
        ctx.moveTo(topX, courtTopY);
        ctx.lineTo(botX, courtBottomY);
        ctx.stroke();
      }

      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1.5;

      var midTopX = (courtTopLeftX + courtTopRightX) / 2;
      var midBotX = (courtBottomLeftX + courtBottomRightX) / 2;
      ctx.beginPath();
      ctx.moveTo(midTopX, courtTopY);
      ctx.lineTo(midBotX, courtBottomY);
      ctx.stroke();

      var midY = (courtTopY + courtBottomY) / 2;
      var midBounds = courtXBoundsAtY(midY);
      var midWidth = midBounds.right - midBounds.left;
      var cx = (midBounds.left + midBounds.right) / 2;
      var crx = midWidth * 0.12;
      ctx.beginPath();
      ctx.ellipse(cx, midY, crx, crx * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();

      var laneWidth = midWidth * 0.11;
      var laneDepth = (courtBottomY - courtTopY) * 0.4;
      ctx.strokeRect(midBounds.left, midY - laneDepth / 2, laneWidth, laneDepth);
      ctx.strokeRect(midBounds.right - laneWidth, midY - laneDepth / 2, laneWidth, laneDepth);

      ctx.restore();

      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1.5;
      courtPath();
      ctx.stroke();
    }

    function drawHoop() {
      var hoop = hoopGeometry();
      var rect = canvas.getBoundingClientRect();
      var shakeX = hoopShakeMag > 0 ? (Math.random() - 0.5) * 5 * hoopShakeMag : 0;
      var shakeY = hoopShakeMag > 0 ? (Math.random() - 0.5) * 3 * hoopShakeMag : 0;

      ctx.save();
      ctx.translate(shakeX, shakeY);

      // Support pole running down to the court's near-right corner.
      ctx.strokeStyle = "#8d8d8d";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(hoop.backboardX + BACKBOARD_WIDTH + 1, hoop.backboardTop + 6);
      ctx.lineTo(rect.width - 5, rect.height - 6);
      ctx.stroke();

      // Backboard
      ctx.fillStyle = "#f5f5f0";
      ctx.strokeStyle = "#8d8d8d";
      ctx.lineWidth = 1;
      ctx.fillRect(hoop.backboardX, hoop.backboardTop, BACKBOARD_WIDTH, BACKBOARD_HEIGHT);
      ctx.strokeRect(hoop.backboardX, hoop.backboardTop, BACKBOARD_WIDTH, BACKBOARD_HEIGHT);

      // Rim — a thin ellipse to suggest the ring viewed at an angle
      var rimCx = (hoop.rimLeftX + hoop.rimRightX) / 2;
      var rimRx = (hoop.rimRightX - hoop.rimLeftX) / 2;
      ctx.strokeStyle = "#ff5a1f";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(rimCx, hoop.rimY, rimRx, 3, 0, 0, Math.PI * 2);
      ctx.stroke();

      // Net — a few simple lines hanging from the rim, tapering inward
      ctx.strokeStyle = "rgba(245,245,245,0.6)";
      ctx.lineWidth = 1;
      var strands = 5;
      var i;
      for (i = 0; i <= strands; i++) {
        var topX = hoop.rimLeftX + ((hoop.rimRightX - hoop.rimLeftX) * i) / strands;
        var bottomX = rimCx + (topX - rimCx) * 0.35;
        ctx.beginPath();
        ctx.moveTo(topX, hoop.rimY);
        ctx.lineTo(bottomX, hoop.rimY + 13);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(hoop.rimLeftX, hoop.rimY + 6);
      ctx.lineTo(hoop.rimRightX, hoop.rimY + 6);
      ctx.stroke();

      ctx.restore();
    }

    function drawAimLine() {
      if (phase !== "aiming") return;
      var dx = dragCurrent.x - ball.x;
      var dy = dragCurrent.y - ball.y;
      var pull = Math.min(MAX_DRAG, Math.sqrt(dx * dx + dy * dy));
      if (pull < MIN_DRAG) return;
      var angle = Math.atan2(dy, dx);
      // The shot fires opposite the drag (pull back, like a slingshot).
      var tipX = ball.x - Math.cos(angle) * pull;
      var tipY = ball.y - Math.sin(angle) * pull;

      ctx.strokeStyle = "rgba(158,232,168,0.8)";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(ball.x, ball.y);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Small arrowhead at the tip so the shot direction is unambiguous.
      var headAngle = Math.atan2(ball.y - tipY, ball.x - tipX);
      ctx.fillStyle = "rgba(158,232,168,0.9)";
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - Math.cos(headAngle - 0.4) * 7, tipY - Math.sin(headAngle - 0.4) * 7);
      ctx.lineTo(tipX - Math.cos(headAngle + 0.4) * 7, tipY - Math.sin(headAngle + 0.4) * 7);
      ctx.closePath();
      ctx.fill();
    }

    function drawBall() {
      ctx.fillStyle = "#ff8a2b";
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, BALL_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      // A couple of seam lines so it reads as a basketball, not a dot.
      ctx.strokeStyle = "rgba(26,26,26,0.6)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ball.x - BALL_RADIUS, ball.y);
      ctx.lineTo(ball.x + BALL_RADIUS, ball.y);
      ctx.moveTo(ball.x, ball.y - BALL_RADIUS);
      ctx.lineTo(ball.x, ball.y + BALL_RADIUS);
      ctx.stroke();
    }

    function drawScorePopup() {
      if (!scorePopup) return;
      var t = scorePopup.ageMs / 700;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.fillStyle = "#9ee8a8";
      ctx.font = "700 14px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("+1", scorePopup.x, scorePopup.y - 10 - t * 18);
      ctx.restore();
    }

    // ---- Input: drag-to-shoot via Pointer Events (mouse, touch, and pen
    // all behave the same way). Pointer capture on the canvas means a drag
    // that leaves its bounds still resolves correctly on release. ----
    function localPos(e) {
      var rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function onPointerDown(e) {
      ensureAudioContext(); // unlock audio now, inside a real user gesture
      if (phase !== "idle") return;
      var p = localPos(e);
      if (distance(p.x, p.y, ball.x, ball.y) > BALL_RADIUS + 8) return; // must grab the ball itself
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      phase = "aiming";
      dragCurrent = p;
    }

    function onPointerMove(e) {
      if (phase !== "aiming") return;
      dragCurrent = localPos(e);
    }

    function onPointerUp(e) {
      if (phase !== "aiming") return;
      var p = localPos(e);
      var dx = p.x - ball.x;
      var dy = p.y - ball.y;
      var pull = Math.sqrt(dx * dx + dy * dy);
      if (pull < MIN_DRAG) {
        phase = "idle"; // treat a too-short drag as a cancelled shot
        return;
      }
      var clamped = Math.min(MAX_DRAG, pull);
      var angle = Math.atan2(dy, dx);
      // Launch opposite the drag direction — pull back, release forward.
      ball.vx = -Math.cos(angle) * clamped * POWER_SCALE;
      ball.vy = -Math.sin(angle) * clamped * POWER_SCALE;
      scoredThisFlight = false;
      flightFloorY = ball.y; // this shot "lands" once it falls back to its own launch height
      phase = "flying";
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", function () {
      phase = "idle";
    });
    window.addEventListener("resize", resize);

    resize();
    respawnBall();

    function loop(ts) {
      if (!running) return;
      if (lastTs == null) lastTs = ts;
      var dt = Math.min(48, ts - lastTs); // clamp so a backgrounded tab can't cause a huge catch-up jump
      lastTs = ts;
      update(dt);
      draw();
      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);

    return {
      destroy: function () {
        running = false;
        if (rafId != null) cancelAnimationFrame(rafId);
        window.removeEventListener("resize", resize);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        if (audioCtx) {
          audioCtx.close().catch(function () {});
          audioCtx = null;
        }
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      },
    };
  }

  window.LoadingGame = { mount: mount };
})();
