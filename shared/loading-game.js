// loading-game.js — a tiny drag-to-shoot basketball mini-game shown during
// the app's loading screens (passage generation, reading scoring,
// comprehension grading) so the wait feels shorter. The court, hoop and
// ball are Luke's own cutout artwork (shared/img/*.png, transparent PNGs)
// composited onto a <canvas> — no framework, no build step. The score
// chime is synthesized with the Web Audio API, so the only network assets
// this file needs are those three images.
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

  // ---- Art assets. Loaded once at script-load time (not per mount) so
  // every loading screen after the first reuses the same cached, already
  // -decoded <img> elements instead of re-requesting them. Paths are
  // resolved against the page, matching how dojo.html already references
  // shared/loading-game.js and shared/theme.css. ----
  var ASSET_BASE = "shared/img/";
  var ASSETS = {
    court: new Image(),
    hoop: new Image(),
    ball: new Image(),
  };
  ASSETS.court.src = ASSET_BASE + "court.png";
  ASSETS.hoop.src = ASSET_BASE + "hoop.png";
  ASSETS.ball.src = ASSET_BASE + "ball.png";
  function imgReady(img) {
    return img.complete && img.naturalWidth > 0;
  }

  // ---- Tunable constants (all physics is time-based — px per
  // millisecond — rather than per-frame, so the game plays at the same
  // speed and difficulty regardless of the device's actual frame rate) ----
  var GRAVITY = 0.0015; // px/ms^2, applied to vertical velocity each frame
  var POWER_SCALE = 0.01; // px/ms of launch speed per px of drag pull
  var MIN_DRAG = 10; // px — shorter drags are treated as a cancelled shot
  var MIN_SHOT_PULL = 38; // px — any valid drag is treated as pulling at least this far, so short-but-real drags still fire a visible shot instead of a barely-there flick
  var MAX_DRAG = 90; // px — pulling further than this doesn't add more power
  var MIN_LAUNCH_VY = -0.22; // px/ms — every shot launches at least this far upward (negative = up), so a mostly-sideways drag still produces a real, visible arc instead of an instant "landing"
  var BALL_RADIUS = 8;
  var BOUNCE_RESTITUTION = 0.45; // velocity retained (and reflected) on a rim/backboard hit
  var POST_RADIUS = 2.5; // collision radius of each rim tip
  var BACKBOARD_COLLISION_DEPTH = 6; // how deep the backboard's front-face collision plane reaches

  // ---- Hoop sprite geometry (shared/img/hoop.png, 350x537). These
  // fractions were measured directly off the artwork (where the backboard
  // and rim actually sit within the transparent canvas) so the physics
  // lines up with what's drawn regardless of what size we render it at. ----
  var HOOP_ASPECT = 350 / 537;
  var HOOP_HEIGHT_FRAC = 0.85; // hoop sprite height as a fraction of the canvas height — sized close to its regular size, but vertically centered instead of pinned to the top
  var HOOP_RIGHT_MARGIN = 10;
  var BACKBOARD_LEFT_FRAC = 0.371;
  var BACKBOARD_RIGHT_FRAC = 0.653;
  var BACKBOARD_TOP_FRAC = 0.02;
  var BACKBOARD_BOTTOM_FRAC = 0.343;
  var RIM_Y_FRAC = 0.371;
  var RIM_LEFT_FRAC = 0.005;
  var RIM_RIGHT_FRAC = 0.371;

  // ---- Court sprite geometry (shared/img/court.png, 1400x583). The
  // floor is measured the same way: these fractions are where the actual
  // wood trapezoid sits within the image, so "anywhere on the court" can
  // be computed after the background is fit to the canvas (see
  // courtGeometry() below, which maps these through the same cover-fit
  // transform used to draw it). ----
  var COURT_IMG_W = 1400;
  var COURT_IMG_H = 583;
  var COURT_TOP_Y_FRAC = 0.376;
  var COURT_TOP_LEFT_X_FRAC = 0.154;
  var COURT_TOP_RIGHT_X_FRAC = 0.845;
  var COURT_BOTTOM_Y_FRAC = 0.99;
  var COURT_BOTTOM_LEFT_X_FRAC = 0.01;
  var COURT_BOTTOM_RIGHT_X_FRAC = 0.99;

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

    // Canvas internal resolution follows its CSS box size (and device
    // pixel ratio) so drawing stays crisp without manually scaling shapes.
    function resize() {
      var rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        // Layout isn't ready yet (can happen the instant a container is
        // inserted into the DOM) — retry next frame instead of sizing
        // everything to 0 and stranding the ball/hoop off-screen.
        requestAnimationFrame(function () {
          if (!running) return;
          resize();
          respawnBall();
        });
        return;
      }
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingQuality = "high";
    }

    // Where the background photo lands once scaled to "cover" the canvas
    // (same maths as CSS background-size:cover) — used both to draw it
    // and to map the court's measured floor fractions into canvas space.
    function courtCoverRect(w, h) {
      var scale = Math.max(w / COURT_IMG_W, h / COURT_IMG_H);
      var dw = COURT_IMG_W * scale;
      var dh = COURT_IMG_H * scale;
      return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
    }

    function courtGeometry() {
      var rect = canvas.getBoundingClientRect();
      var cover = courtCoverRect(rect.width, rect.height);
      return {
        topY: cover.y + COURT_TOP_Y_FRAC * cover.h,
        bottomY: cover.y + COURT_BOTTOM_Y_FRAC * cover.h,
        topLeftX: cover.x + COURT_TOP_LEFT_X_FRAC * cover.w,
        topRightX: cover.x + COURT_TOP_RIGHT_X_FRAC * cover.w,
        bottomLeftX: cover.x + COURT_BOTTOM_LEFT_X_FRAC * cover.w,
        bottomRightX: cover.x + COURT_BOTTOM_RIGHT_X_FRAC * cover.w,
      };
    }

    function courtXBoundsAtY(court, y) {
      var span = court.bottomY - court.topY;
      var t = span > 0 ? (y - court.topY) / span : 0;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      return {
        left: court.topLeftX + (court.bottomLeftX - court.topLeftX) * t,
        right: court.topRightX + (court.bottomRightX - court.topRightX) * t,
      };
    }

    // Hoop sprite placement + the collision points calibrated against it.
    // Recomputed on demand (cheap) rather than cached, so a resize is
    // reflected immediately.
    function hoopGeometry() {
      var rect = canvas.getBoundingClientRect();
      var spriteH = rect.height * HOOP_HEIGHT_FRAC;
      var spriteW = spriteH * HOOP_ASPECT;
      var spriteX = rect.width - HOOP_RIGHT_MARGIN - spriteW;
      var spriteY = (rect.height - spriteH) / 2;
      return {
        spriteX: spriteX,
        spriteY: spriteY,
        spriteW: spriteW,
        spriteH: spriteH,
        backboardLeft: spriteX + BACKBOARD_LEFT_FRAC * spriteW,
        backboardRight: spriteX + BACKBOARD_RIGHT_FRAC * spriteW,
        backboardTop: spriteY + BACKBOARD_TOP_FRAC * spriteH,
        backboardBottom: spriteY + BACKBOARD_BOTTOM_FRAC * spriteH,
        rimY: spriteY + RIM_Y_FRAC * spriteH,
        rimLeftX: spriteX + RIM_LEFT_FRAC * spriteW,
        rimRightX: spriteX + RIM_RIGHT_FRAC * spriteW,
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
      var rect = canvas.getBoundingClientRect();
      var court = courtGeometry();
      var hoop = hoopGeometry();
      // Keep the whole ball on-screen — sample y only within the range
      // where a full BALL_RADIUS circle centered there still fits inside
      // both the court floor and the actual canvas.
      var minY = court.topY + BALL_RADIUS;
      var maxY = Math.min(court.bottomY, rect.height) - BALL_RADIUS;
      var x = 0;
      var y = 0;
      var tries;
      for (tries = 0; tries < 12; tries++) {
        y = minY + Math.random() * Math.max(1, maxY - minY);
        var bounds = courtXBoundsAtY(court, y);
        var usable = Math.max(1, bounds.right - bounds.left - BALL_RADIUS * 2);
        x = bounds.left + BALL_RADIUS + Math.random() * usable;
        var nearHoop =
          x > hoop.spriteX - 26 &&
          x < hoop.spriteX + hoop.spriteW + 10 &&
          y > hoop.spriteY - 15 &&
          y < hoop.spriteY + hoop.spriteH + 15;
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

      // Backboard: a thin vertical wall at its front (left) face — bounce
      // the ball back leftward if it's overlapping that face and still
      // travelling toward it.
      var nearBackboardX =
        ball.x + BALL_RADIUS > hoop.backboardLeft &&
        ball.x - BALL_RADIUS < hoop.backboardLeft + BACKBOARD_COLLISION_DEPTH &&
        ball.y > hoop.backboardTop &&
        ball.y < hoop.backboardBottom;
      if (nearBackboardX && ball.vx > 0) {
        ball.x = hoop.backboardLeft - BALL_RADIUS;
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

      // Floor: whatever happened above, once the ball rises off its launch
      // height and then falls back down through it, the attempt is over —
      // respawn it somewhere fresh on the court. The prevY/vy guards (same
      // pattern as the scoring check above) matter a lot here: without
      // them, "ball.y + BALL_RADIUS >= flightFloorY" is already true at
      // the moment of launch (the ball's own radius alone satisfies it),
      // so almost every shot would "land" on its very first frame — which
      // looked exactly like the ball never left and just teleported.
      if (prevY < flightFloorY && ball.y + BALL_RADIUS >= flightFloorY && ball.vy > 0) {
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

      drawCourt(w, h);
      drawHoop();
      drawAimLine();
      drawBall();

      // Score
      ctx.fillStyle = "#f0f0f0";
      ctx.font = "600 13px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "left";
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = 3;
      ctx.fillText("Score: " + score, 10, 18);
      ctx.shadowBlur = 0;

      drawScorePopup();
    }

    function drawCourt(w, h) {
      if (!imgReady(ASSETS.court)) {
        ctx.fillStyle = "#a97c49"; // plain wood-tone placeholder for the one frame before the photo loads
        ctx.fillRect(0, 0, w, h);
        return;
      }
      var cover = courtCoverRect(w, h);
      ctx.drawImage(ASSETS.court, cover.x, cover.y, cover.w, cover.h);
    }

    function drawHoop() {
      if (!imgReady(ASSETS.hoop)) return;
      var hoop = hoopGeometry();
      var shakeX = hoopShakeMag > 0 ? (Math.random() - 0.5) * 5 * hoopShakeMag : 0;
      var shakeY = hoopShakeMag > 0 ? (Math.random() - 0.5) * 3 * hoopShakeMag : 0;
      ctx.save();
      ctx.translate(shakeX, shakeY);
      ctx.drawImage(ASSETS.hoop, hoop.spriteX, hoop.spriteY, hoop.spriteW, hoop.spriteH);
      ctx.restore();
    }

    function drawAimLine() {
      if (phase !== "aiming") return;
      var dx = dragCurrent.x - ball.x;
      var dy = dragCurrent.y - ball.y;
      var rawPull = Math.sqrt(dx * dx + dy * dy);
      if (rawPull < MIN_DRAG) return;
      // Match the line length to the actual shot power (see onPointerUp),
      // so a short-but-valid drag still shows a real, visible pull.
      var pull = Math.min(MAX_DRAG, Math.max(MIN_SHOT_PULL, rawPull));
      var angle = Math.atan2(dy, dx);
      // The shot fires opposite the drag (pull back, like a slingshot).
      var tipX = ball.x - Math.cos(angle) * pull;
      var tipY = ball.y - Math.sin(angle) * pull;

      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(ball.x, ball.y);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Small arrowhead at the tip so the shot direction is unambiguous.
      var headAngle = Math.atan2(ball.y - tipY, ball.x - tipX);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - Math.cos(headAngle - 0.4) * 7, tipY - Math.sin(headAngle - 0.4) * 7);
      ctx.lineTo(tipX - Math.cos(headAngle + 0.4) * 7, tipY - Math.sin(headAngle + 0.4) * 7);
      ctx.closePath();
      ctx.fill();
    }

    function drawBall() {
      if (imgReady(ASSETS.ball)) {
        ctx.drawImage(ASSETS.ball, ball.x - BALL_RADIUS, ball.y - BALL_RADIUS, BALL_RADIUS * 2, BALL_RADIUS * 2);
        return;
      }
      // Fallback while the sprite is still loading, so the ball is never invisible.
      ctx.fillStyle = "#ff8a2b";
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, BALL_RADIUS, 0, Math.PI * 2);
      ctx.fill();
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
      // Any valid drag is treated as pulling at least MIN_SHOT_PULL, so a
      // short-but-real drag still fires a visible shot instead of a
      // barely-there flick that looks like the ball just teleported.
      var clamped = Math.min(MAX_DRAG, Math.max(MIN_SHOT_PULL, pull));
      var angle = Math.atan2(dy, dx);
      // Launch opposite the drag direction — pull back, release forward.
      ball.vx = -Math.cos(angle) * clamped * POWER_SCALE;
      ball.vy = -Math.sin(angle) * clamped * POWER_SCALE;
      // A mostly-sideways drag can produce almost no vertical speed, so
      // the "flight" ends (falls back to launch height) within a frame or
      // two — looking exactly like the ball did nothing and teleported.
      // Guarantee every shot a real, visible arc regardless of drag angle.
      if (ball.vy > MIN_LAUNCH_VY) ball.vy = MIN_LAUNCH_VY;
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
