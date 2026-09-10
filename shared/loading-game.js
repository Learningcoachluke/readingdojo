// loading-game.js — a tiny, dependency-free endless-runner mini-game shown
// during the app's loading screens (passage generation, reading scoring,
// comprehension grading) so the wait feels shorter. Pure <canvas> + vanilla
// JS, no images or libraries — it injects its own <style> tag on first use,
// so it's a genuine drop-in component: any page can mount it without
// already having matching CSS loaded.
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
    ".lg-canvas{display:block;width:100%;height:150px;background:#000;border-radius:8px;touch-action:manipulation;cursor:pointer;}" +
    ".lg-hint{text-align:center;font-size:12px;color:#9a9a9a;margin-top:8px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;}";

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ---- Tunable constants (all physics is time-based — px per millisecond
  // — rather than per-frame, so the game plays at the same speed and
  // difficulty regardless of the device's actual frame rate) ----
  var GRAVITY = 0.0014; // px/ms^2, applied to vertical velocity each frame
  var JUMP_VELOCITY = -0.4; // px/ms, initial upward speed when jumping
  var BASE_SPEED = 0.28; // px/ms, obstacle scroll speed at the start
  var MAX_SPEED = 0.75; // px/ms, speed cap — keeps it hard but not impossible
  var SPEED_RAMP_PER_MS = 0.000006; // how quickly speed climbs toward MAX_SPEED
  var PLAYER_W = 24;
  var PLAYER_H = 38;
  var PLAYER_X = 32; // fixed on-screen X — the world scrolls, not the player
  var GROUND_MARGIN = 18; // gap between the canvas bottom edge and the ground line

  function mount(container) {
    ensureStyles();

    var wrap = document.createElement("div");
    wrap.className = "lg-wrap";
    var canvas = document.createElement("canvas");
    canvas.className = "lg-canvas";
    wrap.appendChild(canvas);
    var hint = document.createElement("div");
    hint.className = "lg-hint";
    hint.textContent = "Tap or press Space to jump";
    wrap.appendChild(hint);
    container.appendChild(wrap);

    var ctx = canvas.getContext("2d");
    var groundY = 120;

    // Canvas internal resolution follows its CSS box size (and device
    // pixel ratio) so drawing stays crisp without manually scaling shapes.
    function resize() {
      var rect = canvas.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      groundY = rect.height - GROUND_MARGIN;
    }

    // ---- Game state ----
    var playerY = 0; // vertical offset from standing (negative = airborne, 0 = on ground)
    var velocityY = 0;
    var onGround = true;
    var obstacles = []; // { x, width, height } — x is the obstacle's left edge
    var spawnTimerMs = 0;
    var speed = BASE_SPEED;
    var elapsedMs = 0;
    var score = 0;
    var runFrame = 0; // drives the simple 2-pose running-leg animation
    var gameOver = false;
    var running = true; // flips false once destroy() runs, to stop the rAF loop
    var rafId = null;
    var lastTs = null;

    function reset() {
      playerY = 0;
      velocityY = 0;
      onGround = true;
      obstacles = [];
      spawnTimerMs = randomSpawnDelay();
      speed = BASE_SPEED;
      elapsedMs = 0;
      score = 0;
      gameOver = false;
    }

    // Spikes come in faster as speed increases, with randomness so the
    // spacing never feels mechanical.
    function randomSpawnDelay() {
      var base = 900 - (speed - BASE_SPEED) * 600;
      return Math.max(450, base) + Math.random() * 400;
    }

    function jump() {
      if (gameOver) {
        reset();
        return;
      }
      if (onGround) {
        velocityY = JUMP_VELOCITY;
        onGround = false;
      }
    }

    function onKeyDown(e) {
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault(); // stop the page from scrolling on spacebar
        jump();
      }
    }
    function onPointerDown(e) {
      e.preventDefault();
      jump();
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", resize);
    canvas.addEventListener("pointerdown", onPointerDown);

    reset();
    resize();

    function update(dt) {
      if (gameOver) return;

      elapsedMs += dt;
      score = Math.floor(elapsedMs / 100);
      speed = Math.min(MAX_SPEED, BASE_SPEED + elapsedMs * SPEED_RAMP_PER_MS);

      // Gravity integration — simple Euler step, plenty accurate at this scale.
      velocityY += GRAVITY * dt;
      playerY += velocityY * dt;
      if (playerY >= 0) {
        playerY = 0;
        velocityY = 0;
        onGround = true;
      }
      if (onGround) runFrame += dt;

      // Spawn and advance obstacles; drop ones that have scrolled off-screen.
      spawnTimerMs -= dt;
      if (spawnTimerMs <= 0) {
        var canvasWidth = canvas.getBoundingClientRect().width;
        var h = 18 + Math.random() * 22;
        obstacles.push({ x: canvasWidth, width: 14, height: h });
        spawnTimerMs = randomSpawnDelay();
      }
      for (var i = obstacles.length - 1; i >= 0; i--) {
        obstacles[i].x -= speed * dt;
        if (obstacles[i].x + obstacles[i].width < 0) obstacles.splice(i, 1);
      }

      checkCollisions();
    }

    // Simple AABB overlap test, with a small inset on the player's hitbox
    // so close near-misses still feel fair rather than cheap.
    function checkCollisions() {
      var feetY = groundY + playerY;
      var playerBox = {
        x: PLAYER_X + 4,
        y: feetY - PLAYER_H + 4,
        w: PLAYER_W - 8,
        h: PLAYER_H - 8,
      };
      for (var i = 0; i < obstacles.length; i++) {
        var ob = obstacles[i];
        var obBox = { x: ob.x, y: groundY - ob.height, w: ob.width, h: ob.height };
        var overlap =
          playerBox.x < obBox.x + obBox.w &&
          playerBox.x + playerBox.w > obBox.x &&
          playerBox.y < obBox.y + obBox.h &&
          playerBox.y + playerBox.h > obBox.y;
        if (overlap) {
          gameOver = true;
          return;
        }
      }
    }

    function draw() {
      var rect = canvas.getBoundingClientRect();
      var w = rect.width;
      var h = rect.height;
      ctx.clearRect(0, 0, w, h);

      // Ground line
      ctx.strokeStyle = "#3a4050";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, groundY + 1);
      ctx.lineTo(w, groundY + 1);
      ctx.stroke();

      // Obstacles — simple triangular spikes
      ctx.fillStyle = "#ff8a2b";
      for (var i = 0; i < obstacles.length; i++) {
        var ob = obstacles[i];
        ctx.beginPath();
        ctx.moveTo(ob.x, groundY);
        ctx.lineTo(ob.x + ob.width / 2, groundY - ob.height);
        ctx.lineTo(ob.x + ob.width, groundY);
        ctx.closePath();
        ctx.fill();
      }

      drawPlayer();

      // Score
      ctx.fillStyle = "#f0f0f0";
      ctx.font = "600 13px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText("Score: " + score, w - 10, 18);

      if (gameOver) {
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#9ee8a8";
        ctx.textAlign = "center";
        ctx.font = "700 16px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillText("Game Over", w / 2, h / 2 - 6);
        ctx.fillStyle = "#f0f0f0";
        ctx.font = "600 12px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillText("Tap or press Space to try again", w / 2, h / 2 + 14);
      }
    }

    // Manual rounded-rect path (rather than ctx.roundRect, which isn't in
    // every WebView this might run in) — used for the gi/torso.
    function roundRectPath(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    // A small martial-arts figure in a fighting stance — drawn from
    // primitives (no image assets needed): a filled gi (torso) with a
    // black belt, a headband, and thick rounded-cap limb strokes instead
    // of thin wireframe lines so it reads as a solid character even at
    // this small size. Legs alternate between two run poses and tuck up
    // into a third pose mid-air.
    function drawPlayer() {
      var feetY = groundY + playerY;
      var legPose = onGround ? Math.floor(runFrame / 90) % 2 : 2; // 0/1 = run cycle, 2 = jump tuck
      var cx = PLAYER_W / 2;
      var GI = "#f2f2f2";
      var hipY = -PLAYER_H + 26;

      ctx.save();
      ctx.translate(PLAYER_X, feetY);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Legs (drawn first so the gi hem overlaps them slightly)
      ctx.strokeStyle = GI;
      ctx.lineWidth = 5;
      ctx.beginPath();
      if (legPose === 2) {
        ctx.moveTo(cx, hipY);
        ctx.lineTo(cx - 6, hipY + 10);
        ctx.moveTo(cx, hipY);
        ctx.lineTo(cx + 6, hipY + 10);
      } else if (legPose === 0) {
        ctx.moveTo(cx, hipY);
        ctx.lineTo(cx - 9, 0);
        ctx.moveTo(cx, hipY);
        ctx.lineTo(cx + 5, 0);
      } else {
        ctx.moveTo(cx, hipY);
        ctx.lineTo(cx + 9, 0);
        ctx.moveTo(cx, hipY);
        ctx.lineTo(cx - 5, 0);
      }
      ctx.stroke();

      // Torso — the gi, a filled rounded rectangle
      ctx.fillStyle = GI;
      roundRectPath(cx - 7, -PLAYER_H + 11, 14, 17, 4);
      ctx.fill();

      // Belt — black with a thin mint trim so it stays visible against
      // the black canvas background, plus two hanging ends. A small nod
      // to "Black Belt" itself.
      ctx.fillStyle = "#1a1a1a";
      ctx.strokeStyle = "#9ee8a8";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(cx - 7, hipY - 5, 14, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillRect(cx - 3, hipY, 3, 8);
      ctx.fillRect(cx + 1, hipY, 3, 9);

      // Arms — front arm punched forward with a small fist, rear arm back
      ctx.strokeStyle = GI;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(cx, -PLAYER_H + 16);
      ctx.lineTo(cx + 10, -PLAYER_H + 19);
      ctx.moveTo(cx, -PLAYER_H + 16);
      ctx.lineTo(cx - 7, -PLAYER_H + 23);
      ctx.stroke();
      ctx.fillStyle = GI;
      ctx.beginPath();
      ctx.arc(cx + 11, -PLAYER_H + 19, 2.5, 0, Math.PI * 2);
      ctx.fill();

      // Head
      ctx.fillStyle = GI;
      ctx.beginPath();
      ctx.arc(cx, -PLAYER_H + 5, 7, 0, Math.PI * 2);
      ctx.fill();

      // Headband, tied off with a short trailing tail
      ctx.fillStyle = "#9ee8a8";
      ctx.fillRect(cx - 7, -PLAYER_H + 3, 14, 3);
      ctx.beginPath();
      ctx.moveTo(cx + 7, -PLAYER_H + 4);
      ctx.lineTo(cx + 13, -PLAYER_H + 2);
      ctx.lineTo(cx + 13, -PLAYER_H + 6);
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    }

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
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("resize", resize);
        canvas.removeEventListener("pointerdown", onPointerDown);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      },
    };
  }

  window.LoadingGame = { mount: mount };
})();
