// runner-game.js — a tiny "Chrome dino" style endless-runner mini-game
// shown during the app's loading screens, alongside loading-game.js
// (basketball) and soccer-game.js. Same drop-in contract, third sport:
// tap to jump a skateboarder over road cones scrolling in from the right,
// against Luke's own cutout artwork (shared/img/*.png).
//
// Usage:
//   const game = RunnerGame.mount(containerEl);
//   game.destroy();

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

  var ASSET_BASE = "shared/img/";
  var ASSETS = {
    skyline: new Image(),
    skater: new Image(),
    cone: new Image(),
  };
  ASSETS.skyline.src = ASSET_BASE + "skyline.png";
  ASSETS.skater.src = ASSET_BASE + "skater.png";
  ASSETS.cone.src = ASSET_BASE + "cone.png";
  function imgReady(img) {
    return img.complete && img.naturalWidth > 0;
  }

  // ---- Tunable constants ----
  var GRAVITY = 0.0016; // px/ms^2
  var JUMP_SPEED = 0.42 * Math.sqrt(1.1); // px/ms, upward — jump height scales with velocity squared, so this is a genuine 10% higher jump per feedback
  var SCROLL_SPEED = 0.13 * 1.2; // px/ms, cones move leftward at this constant speed — sped up 20% per feedback
  var MIN_SPAWN_GAP_MS = 1300;
  var MAX_SPAWN_GAP_MS = 2500;
  // Collision boxes are narrower than the sprites themselves — a forgiving
  // hitbox, same idea as any dino-runner clone. This matters more than it
  // looks: the jump's airtime has to comfortably exceed how long a cone
  // takes to cross the skater's hitbox, or clearing one is never possible
  // no matter how well it's timed.
  var SKATER_HITBOX_SCALE = 0.5;
  var CONE_HITBOX_SCALE = 0.7;

  // ---- Sprite geometry, as fractions of canvas size — kept resolution
  // -independent, same approach as the other two games. ----
  var GROUND_Y_FRAC = 0.87;
  var SKATER_HEIGHT_FRAC = 0.42; // of canvas height
  var SKATER_ASPECT = 220 / 272; // shared/img/skater.png
  var SKATER_X_FRAC = 0.14; // fixed horizontal position, as a fraction of canvas width
  var CONE_HEIGHT_FRAC_OF_SKATER = 0.46;
  var CONE_ASPECT = 120 / 158; // shared/img/cone.png
  // Skyline image (1400x583) is already ~edge-to-edge horizontally; drawn
  // as a static backdrop scaled to cover the canvas width, anchored so
  // its own bottom edge sits right on the ground line.
  var SKYLINE_IMG_W = 1400;
  var SKYLINE_IMG_H = 583;

  function mount(container) {
    ensureStyles();

    var wrap = document.createElement("div");
    wrap.className = "lg-wrap";
    var canvas = document.createElement("canvas");
    canvas.className = "lg-canvas";
    wrap.appendChild(canvas);
    var hint = document.createElement("div");
    hint.className = "lg-hint";
    hint.textContent = "Tap to jump";
    wrap.appendChild(hint);
    container.appendChild(wrap);

    var ctx = canvas.getContext("2d");

    function resize() {
      var rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        requestAnimationFrame(function () {
          if (!running) return;
          resize();
        });
        return;
      }
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingQuality = "high";
    }

    function skaterGeometry() {
      var rect = canvas.getBoundingClientRect();
      var groundY = rect.height * GROUND_Y_FRAC;
      var h = rect.height * SKATER_HEIGHT_FRAC;
      var w = h * SKATER_ASPECT;
      var x = rect.width * SKATER_X_FRAC;
      return { groundY: groundY, x: x, w: w, h: h };
    }

    function coneSize() {
      var skater = skaterGeometry();
      var h = skater.h * CONE_HEIGHT_FRAC_OF_SKATER;
      var w = h * CONE_ASPECT;
      return { w: w, h: h };
    }

    // ---- Game state ----
    var running = true;
    var rafId = null;
    var lastTs = null;
    var score = 0;
    var audioCtx = null;

    var jumpHeight = 0; // px above the ground; 0 = grounded
    var jumpVel = 0; // px/ms, positive = moving up
    var jumping = false;

    var cones = []; // { x, scored, hitFlash }
    var nextSpawnInMs = 900;
    var hitFlashMs = 0; // brief red flash on the skater after a collision
    var gameOver = false; // frozen after a collision until the player taps to restart

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

    function playHitThud() {
      var ac = ensureAudioContext();
      if (!ac) return;
      try {
        var now = ac.currentTime;
        var osc = ac.createOscillator();
        var gain = ac.createGain();
        osc.type = "square";
        osc.frequency.value = 140;
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
        osc.connect(gain).connect(ac.destination);
        osc.start(now);
        osc.stop(now + 0.16);
      } catch (e) {
        // Ignore.
      }
    }

    function jump() {
      if (jumping) return;
      jumping = true;
      jumpVel = JUMP_SPEED;
      ensureAudioContext();
    }

    function restart() {
      gameOver = false;
      cones = [];
      hitFlashMs = 0;
      jumping = false;
      jumpVel = 0;
      jumpHeight = 0;
      nextSpawnInMs = 900;
      hint.textContent = "Tap to jump";
    }

    function spawnCone() {
      var rect = canvas.getBoundingClientRect();
      cones.push({ x: rect.width + coneSize().w, scored: false });
      nextSpawnInMs = MIN_SPAWN_GAP_MS + Math.random() * (MAX_SPAWN_GAP_MS - MIN_SPAWN_GAP_MS);
    }

    function rectsOverlap(a, b) {
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    }

    function update(dt) {
      if (hitFlashMs > 0) hitFlashMs -= dt;
      if (gameOver) return; // frozen on the collision until the player taps to restart

      // Jump physics — always active, independent of anything else.
      if (jumping) {
        jumpVel -= GRAVITY * dt;
        jumpHeight += jumpVel * dt;
        if (jumpHeight <= 0) {
          jumpHeight = 0;
          jumpVel = 0;
          jumping = false;
        }
      }

      var skater = skaterGeometry();
      var cone = coneSize();
      var skaterHalfW = (skater.w * SKATER_HITBOX_SCALE) / 2;
      var skaterBox = {
        left: skater.x - skaterHalfW,
        right: skater.x + skaterHalfW,
        top: skater.groundY - skater.h - jumpHeight,
        bottom: skater.groundY - jumpHeight,
      };
      var coneHalfW = (cone.w * CONE_HITBOX_SCALE) / 2;

      nextSpawnInMs -= dt;
      if (nextSpawnInMs <= 0) spawnCone();

      for (var i = cones.length - 1; i >= 0; i--) {
        var c = cones[i];
        c.x -= SCROLL_SPEED * dt;

        var coneBox = {
          left: c.x - coneHalfW,
          right: c.x + coneHalfW,
          top: skater.groundY - cone.h,
          bottom: skater.groundY,
        };

        if (!c.scored && rectsOverlap(skaterBox, coneBox)) {
          c.scored = true; // only ever counts once, whether it's a hit or a clean dodge
          hitFlashMs = 220;
          playHitThud();
          score = 0;
          gameOver = true;
          jumping = false;
          jumpVel = 0;
          jumpHeight = 0;
          hint.textContent = "Tap to restart";
        } else if (!c.scored && coneBox.right < skaterBox.left) {
          c.scored = true;
          score += 1;
          playScoreChime();
        }

        if (c.x < -cone.w) cones.splice(i, 1);
      }
    }

    function draw() {
      var rect = canvas.getBoundingClientRect();
      var w = rect.width;
      var h = rect.height;
      ctx.clearRect(0, 0, w, h);

      drawSkyline(w, h);

      var skater = skaterGeometry();

      // Ground line
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, skater.groundY + 1);
      ctx.lineTo(w, skater.groundY + 1);
      ctx.stroke();

      drawCones();
      drawSkater(skater);

      ctx.fillStyle = "#f0f0f0";
      ctx.font = "600 13px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("Score: " + score, 10, 18);

      if (gameOver) {
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#f0f0f0";
        ctx.font = "700 16px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Tap to restart", w / 2, h / 2);
      }
    }

    function drawSkyline(w, h) {
      if (!imgReady(ASSETS.skyline)) return;
      var groundY = h * GROUND_Y_FRAC;
      var scale = w / SKYLINE_IMG_W;
      var dh = SKYLINE_IMG_H * scale;
      ctx.drawImage(ASSETS.skyline, 0, groundY - dh, w, dh);
    }

    function drawCones() {
      if (!imgReady(ASSETS.cone)) return;
      var skater = skaterGeometry();
      var cone = coneSize();
      cones.forEach(function (c) {
        ctx.drawImage(ASSETS.cone, c.x - cone.w / 2, skater.groundY - cone.h, cone.w, cone.h);
      });
    }

    function drawSkater(skater) {
      var y = skater.groundY - skater.h - jumpHeight;
      if (imgReady(ASSETS.skater)) {
        if (hitFlashMs > 0) {
          ctx.save();
          ctx.filter = "sepia(1) saturate(6) hue-rotate(-50deg)";
          ctx.drawImage(ASSETS.skater, skater.x - skater.w / 2, y, skater.w, skater.h);
          ctx.restore();
        } else {
          ctx.drawImage(ASSETS.skater, skater.x - skater.w / 2, y, skater.w, skater.h);
        }
        return;
      }
      ctx.fillStyle = hitFlashMs > 0 ? "#e8735c" : "#f0f0f0";
      ctx.fillRect(skater.x - skater.w / 2, y, skater.w, skater.h);
    }

    function onPointerDown(e) {
      e.preventDefault();
      if (gameOver) {
        restart();
        return;
      }
      jump();
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", resize);

    resize();

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
        if (audioCtx) {
          audioCtx.close().catch(function () {});
          audioCtx = null;
        }
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      },
    };
  }

  window.RunnerGame = { mount: mount };
})();
