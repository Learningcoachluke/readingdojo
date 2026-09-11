// soccer-game.js — a tiny drag-to-shoot penalty-kick mini-game shown during
// the app's loading screens, alongside loading-game.js (basketball). Same
// idea, same drop-in contract, different sport: pitch/goal/keeper/ball are
// Luke's own cutout artwork (shared/img/*.png) composited onto a <canvas>.
// Unlike the basketball game, shots here travel in a straight line (no
// gravity) toward a goalkeeper who slides side to side — dodge the keeper
// and split the posts to score.
//
// Usage:
//   const game = SoccerGame.mount(containerEl);
//   game.destroy();
//
// Only one instance should be mounted at a time per page (same convention
// as LoadingGame) — the host page destroys the previous game before the
// next loading screen mounts a new one.

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

  // ---- Art assets, loaded once at script-load time and shared across
  // every mount (same pattern as loading-game.js). ----
  var ASSET_BASE = "shared/img/";
  var ASSETS = {
    pitch: new Image(),
    goal: new Image(),
    keeper: new Image(),
    ball: new Image(),
  };
  ASSETS.pitch.src = ASSET_BASE + "pitch.png";
  ASSETS.goal.src = ASSET_BASE + "goal.png";
  ASSETS.keeper.src = ASSET_BASE + "keeper.png";
  ASSETS.ball.src = ASSET_BASE + "soccer-ball.png";
  function imgReady(img) {
    return img.complete && img.naturalWidth > 0;
  }

  // ---- Tunable constants. No gravity here — shots travel in a straight
  // line at a constant velocity, unlike the basketball game's arc. ----
  var SHOT_SPEED_SCALE = 0.005; // px/ms of speed per px of drag pull
  var MIN_DRAG = 10; // px — shorter drags are treated as a cancelled shot
  var MIN_SHOT_PULL = 38; // px — any valid drag is treated as pulling at least this far
  var MAX_DRAG = 90; // px — pulling further than this doesn't add more power
  var MIN_LAUNCH_VY = -0.16; // px/ms — every shot travels at least this fast toward the goal (negative = up/away), so a mostly-sideways drag still produces a real shot
  var BALL_RADIUS = 8;
  var BOUNCE_RESTITUTION = 0.5; // velocity retained (and reflected) on a post/keeper hit
  var POST_RADIUS = 4; // collision radius of each goal post

  // ---- Goal sprite geometry (shared/img/goal.png, 450x301). Measured
  // directly off the artwork, same approach as the basketball hoop: the
  // posts and the ground line are expressed as fractions of the sprite so
  // collision lines up with whatever size we render it at. ----
  var GOAL_ASPECT = 450 / 301;
  var GOAL_WIDTH_FRAC = 0.32; // goal sprite width as a fraction of canvas width (shrunk 20% per feedback — the goal was too easy to hit)
  var GOAL_LEFT_POST_FRAC = 0.047;
  var GOAL_RIGHT_POST_FRAC = 0.953;
  var GOAL_GROUND_FRAC = 0.995; // where the posts meet the ground (= the goal line)

  // ---- Keeper sprite geometry (shared/img/keeper.png, 160x260). ----
  var KEEPER_ASPECT = 160 / 260;
  var KEEPER_HEIGHT_FRAC_OF_GOAL = 0.8; // keeper height as a fraction of the goal sprite's height
  var KEEPER_SPEED = ((2 * Math.PI) / 2600) * 1.2; // radians/ms — one full side-to-side sweep every 2.6s, sped up 20% per feedback

  // ---- Pitch sprite geometry (shared/img/pitch.png, 1400x583). Measured
  // the same way as the basketball court background. ----
  var PITCH_IMG_W = 1400;
  var PITCH_IMG_H = 583;
  var PITCH_TOP_Y_FRAC = 0.511;
  var PITCH_TOP_LEFT_X_FRAC = 0.05;
  var PITCH_TOP_RIGHT_X_FRAC = 0.949;
  var PITCH_BOTTOM_Y_FRAC = 0.99;
  var PITCH_BOTTOM_LEFT_X_FRAC = 0.01;
  var PITCH_BOTTOM_RIGHT_X_FRAC = 0.99;

  var BALL_LINE_Y_FRAC = 0.86; // where the ball rests/respawns, as a fraction of canvas height

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

    function resize() {
      var rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        // Layout isn't ready yet — retry next frame instead of sizing
        // everything to 0 and stranding the ball/goal off-screen.
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

    function pitchCoverRect(w, h) {
      var scale = Math.max(w / PITCH_IMG_W, h / PITCH_IMG_H);
      var dw = PITCH_IMG_W * scale;
      var dh = PITCH_IMG_H * scale;
      return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
    }

    function pitchGeometry() {
      var rect = canvas.getBoundingClientRect();
      var cover = pitchCoverRect(rect.width, rect.height);
      return {
        topY: cover.y + PITCH_TOP_Y_FRAC * cover.h,
        bottomY: cover.y + PITCH_BOTTOM_Y_FRAC * cover.h,
        topLeftX: cover.x + PITCH_TOP_LEFT_X_FRAC * cover.w,
        topRightX: cover.x + PITCH_TOP_RIGHT_X_FRAC * cover.w,
        bottomLeftX: cover.x + PITCH_BOTTOM_LEFT_X_FRAC * cover.w,
        bottomRightX: cover.x + PITCH_BOTTOM_RIGHT_X_FRAC * cover.w,
      };
    }

    // Goal placement + the post/goal-line collision points calibrated
    // against the artwork. The goal's ground line is anchored to sit
    // exactly where the pitch photo's horizon (its measured top edge) is.
    function goalGeometry() {
      var rect = canvas.getBoundingClientRect();
      var pitch = pitchGeometry();
      var spriteW = rect.width * GOAL_WIDTH_FRAC;
      var spriteH = spriteW / GOAL_ASPECT;
      var spriteX = (rect.width - spriteW) / 2;
      var spriteY = pitch.topY - GOAL_GROUND_FRAC * spriteH;
      var goalLineY = spriteY + GOAL_GROUND_FRAC * spriteH;
      return {
        spriteX: spriteX,
        spriteY: spriteY,
        spriteW: spriteW,
        spriteH: spriteH,
        leftPostX: spriteX + GOAL_LEFT_POST_FRAC * spriteW,
        rightPostX: spriteX + GOAL_RIGHT_POST_FRAC * spriteW,
        goalLineY: goalLineY,
      };
    }

    function keeperGeometry(t) {
      var goal = goalGeometry();
      var spriteH = goal.spriteH * KEEPER_HEIGHT_FRAC_OF_GOAL;
      var spriteW = spriteH * KEEPER_ASPECT;
      var centerX = (goal.leftPostX + goal.rightPostX) / 2;
      var amplitude = Math.max(0, (goal.rightPostX - goal.leftPostX) / 2 - spriteW / 2 - 4);
      var cx = centerX + amplitude * Math.sin(t * KEEPER_SPEED);
      return {
        centerX: cx,
        spriteX: cx - spriteW / 2,
        spriteY: goal.goalLineY - spriteH,
        spriteW: spriteW,
        spriteH: spriteH,
        collideRadius: spriteW * 0.42,
      };
    }

    // ---- Game state ----
    var ball = { x: 60, y: 0, vx: 0, vy: 0 };
    var phase = "idle"; // 'idle' | 'aiming' | 'flying'
    var dragCurrent = { x: 0, y: 0 };
    var scoredThisFlight = false;
    var score = 0;
    var goalShakeMag = 0;
    var scorePopup = null;
    var running = true;
    var rafId = null;
    var lastTs = null;
    var audioCtx = null;
    var keeperT = 0; // ms accumulator driving the keeper's side-to-side sweep
    var flightStartY = 0; // the ball's own launch height, for the "deflected back past start" reset

    function respawnBall() {
      var rect = canvas.getBoundingClientRect();
      var goal = goalGeometry();
      var lineY = Math.min(rect.height - BALL_RADIUS - 2, rect.height * BALL_LINE_Y_FRAC);
      var goalHalfWidth = (goal.rightPostX - goal.leftPostX) / 2;
      var centerX = (goal.leftPostX + goal.rightPostX) / 2;
      var range = goalHalfWidth * 1.7;
      var minX = Math.max(BALL_RADIUS, centerX - range);
      var maxX = Math.min(rect.width - BALL_RADIUS, centerX + range);
      ball.x = minX + Math.random() * Math.max(1, maxX - minX);
      ball.y = lineY;
      ball.vx = 0;
      ball.vy = 0;
      phase = "idle";
    }

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
        // Ignore — audio must never be able to break the game loop.
      }
    }

    function distance(x1, y1, x2, y2) {
      var dx = x2 - x1;
      var dy = y2 - y1;
      return Math.sqrt(dx * dx + dy * dy);
    }

    // Reflects the ball's velocity off a point obstacle (a post or the
    // keeper), same maths as the basketball game's rim-tip bounce.
    function bounceOffPoint(px, py, obstacleRadius) {
      var dx = ball.x - px;
      var dy = ball.y - py;
      var dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
      var nx = dx / dist;
      var ny = dy / dist;
      var overlap = BALL_RADIUS + obstacleRadius - dist;
      if (overlap > 0) {
        ball.x += nx * overlap;
        ball.y += ny * overlap;
      }
      var dot = ball.vx * nx + ball.vy * ny;
      ball.vx = (ball.vx - 2 * dot * nx) * BOUNCE_RESTITUTION;
      ball.vy = (ball.vy - 2 * dot * ny) * BOUNCE_RESTITUTION;
      goalShakeMag = 1;
    }

    function updateFlying(dt, prevY) {
      var rect = canvas.getBoundingClientRect();
      var goal = goalGeometry();
      var keeper = keeperGeometry(keeperT);
      var hitObstacle = false;

      if (distance(ball.x, ball.y, goal.leftPostX, goal.goalLineY) < BALL_RADIUS + POST_RADIUS) {
        bounceOffPoint(goal.leftPostX, goal.goalLineY, POST_RADIUS);
        hitObstacle = true;
      } else if (distance(ball.x, ball.y, goal.rightPostX, goal.goalLineY) < BALL_RADIUS + POST_RADIUS) {
        bounceOffPoint(goal.rightPostX, goal.goalLineY, POST_RADIUS);
        hitObstacle = true;
      } else if (distance(ball.x, ball.y, keeper.centerX, goal.goalLineY) < BALL_RADIUS + keeper.collideRadius) {
        bounceOffPoint(keeper.centerX, goal.goalLineY, keeper.collideRadius);
        hitObstacle = true;
      }

      // Scoring: the ball must have been below the goal line last frame
      // and at or above it now, still travelling up, land between the
      // posts, and not have just been saved/deflected this same frame.
      var margin = BALL_RADIUS * 0.6;
      if (
        !hitObstacle &&
        !scoredThisFlight &&
        prevY > goal.goalLineY &&
        ball.y <= goal.goalLineY &&
        ball.vy < 0 &&
        ball.x > goal.leftPostX + margin &&
        ball.x < goal.rightPostX - margin
      ) {
        scoredThisFlight = true;
        score += 1;
        scorePopup = { ageMs: 0, x: (goal.leftPostX + goal.rightPostX) / 2, y: goal.goalLineY };
        playScoreChime();
      }

      // The attempt is over once the ball has clearly passed the goal
      // line (scored or missed wide) — mirrors the basketball game's
      // floor check: requiring prevY to have been on the near side first
      // stops this from firing the instant the shot launches.
      var respawnLineY = goal.goalLineY - 15;
      if (prevY > respawnLineY && ball.y <= respawnLineY) {
        respawnBall();
        return;
      }
      // Deflected back toward the kicker (post/keeper bounce) — once it
      // falls back past its own launch height, the attempt is over too.
      if (prevY < flightStartY && ball.y >= flightStartY && ball.vy > 0) {
        respawnBall();
        return;
      }
      // Safety net for an extreme-angle shot that exits the sides.
      if (ball.x < -30 || ball.x > rect.width + 30) {
        respawnBall();
      }
    }

    function update(dt) {
      keeperT += dt;
      if (goalShakeMag > 0) {
        goalShakeMag *= 0.85;
        if (goalShakeMag < 0.02) goalShakeMag = 0;
      }
      if (scorePopup) {
        scorePopup.ageMs += dt;
        if (scorePopup.ageMs > 700) scorePopup = null;
      }

      if (phase !== "flying") return;

      var prevY = ball.y;
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      updateFlying(dt, prevY);
    }

    function draw() {
      var rect = canvas.getBoundingClientRect();
      var w = rect.width;
      var h = rect.height;
      ctx.clearRect(0, 0, w, h);

      drawPitch(w, h);
      drawGoal();
      drawKeeper();
      drawAimLine();
      drawBall();

      ctx.fillStyle = "#f0f0f0";
      ctx.font = "600 13px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "left";
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = 3;
      ctx.fillText("Score: " + score, 10, 18);
      ctx.shadowBlur = 0;

      drawScorePopup();
    }

    function drawPitch(w, h) {
      if (!imgReady(ASSETS.pitch)) {
        ctx.fillStyle = "#3a8f3a";
        ctx.fillRect(0, 0, w, h);
        return;
      }
      var cover = pitchCoverRect(w, h);
      ctx.drawImage(ASSETS.pitch, cover.x, cover.y, cover.w, cover.h);
    }

    function drawGoal() {
      if (!imgReady(ASSETS.goal)) return;
      var goal = goalGeometry();
      var shakeX = goalShakeMag > 0 ? (Math.random() - 0.5) * 5 * goalShakeMag : 0;
      var shakeY = goalShakeMag > 0 ? (Math.random() - 0.5) * 3 * goalShakeMag : 0;
      ctx.save();
      ctx.translate(shakeX, shakeY);
      ctx.drawImage(ASSETS.goal, goal.spriteX, goal.spriteY, goal.spriteW, goal.spriteH);
      ctx.restore();
    }

    function drawKeeper() {
      if (!imgReady(ASSETS.keeper)) return;
      var keeper = keeperGeometry(keeperT);
      ctx.drawImage(ASSETS.keeper, keeper.spriteX, keeper.spriteY, keeper.spriteW, keeper.spriteH);
    }

    function drawAimLine() {
      if (phase !== "aiming") return;
      var dx = dragCurrent.x - ball.x;
      var dy = dragCurrent.y - ball.y;
      var rawPull = Math.sqrt(dx * dx + dy * dy);
      if (rawPull < MIN_DRAG) return;
      var pull = Math.min(MAX_DRAG, Math.max(MIN_SHOT_PULL, rawPull));
      var angle = Math.atan2(dy, dx);
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
      ctx.fillStyle = "#f0f0f0";
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

    function localPos(e) {
      var rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function onPointerDown(e) {
      ensureAudioContext();
      if (phase !== "idle") return;
      var p = localPos(e);
      if (distance(p.x, p.y, ball.x, ball.y) > BALL_RADIUS + 8) return;
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
        phase = "idle";
        return;
      }
      var clamped = Math.min(MAX_DRAG, Math.max(MIN_SHOT_PULL, pull));
      var angle = Math.atan2(dy, dx);
      ball.vx = -Math.cos(angle) * clamped * SHOT_SPEED_SCALE;
      ball.vy = -Math.sin(angle) * clamped * SHOT_SPEED_SCALE;
      // Guarantee a real, visible shot toward the goal regardless of drag
      // angle — same fix the basketball game needed for flat drags.
      if (ball.vy > MIN_LAUNCH_VY) ball.vy = MIN_LAUNCH_VY;
      scoredThisFlight = false;
      flightStartY = ball.y;
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
      var dt = Math.min(48, ts - lastTs);
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

  window.SoccerGame = { mount: mount };
})();
