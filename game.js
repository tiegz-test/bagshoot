// ─── Constants ───────────────────────────────────────────────────────────────
const CANVAS_W = 480;
const CANVAS_H = 600;
const R = 22;                         // bubble radius
const DIAM = R * 2;
const ROW_H = R * Math.sqrt(3);       // vertical distance between row centers
const COLS = 10;
const ROWS = 12;                      // total logical rows (top 8 populated at start)
const INIT_ROWS = 8;
const MARGIN = R;                     // left margin so col0 center sits at R+offset
const TOP = R + 4;                    // y of row-0 center
const CANNON_X = CANVAS_W / 2;
const CANNON_Y = CANVAS_H - 50;
const CANNON_LEN = 50;
const BUBBLE_SPEED = 600;             // px/s
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22'];

// ─── Hex neighbour offsets (even-row / odd-row) ──────────────────────────────
// Even rows have no column offset; odd rows are offset right by R.
const NEIGHBORS = {
  even: [[-1, -1], [-1, 0], [0, -1], [0, 1], [1, -1], [1, 0]],
  odd:  [[-1,  0], [-1, 1], [0, -1], [0, 1], [1,  0], [1, 1]],
};

// ─── State ────────────────────────────────────────────────────────────────────
let grid;          // grid[row][col] = color string | null
let flying;        // { x, y, vx, vy, color } | null
let nextColor;
let cannonAngle;   // radians; 0 = straight up, negative = left, positive = right
let score;
let gameOver;
let pops;          // [{x,y,r,alpha}] pop animations

// ─── Canvas / DOM ─────────────────────────────────────────────────────────────
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const nextCanvas = document.getElementById('next-canvas');
const nextCtx = nextCanvas.getContext('2d');
const scoreEl = document.getElementById('score-display');
const overlay = document.getElementById('overlay');
const overlayScore = document.getElementById('overlay-score');
const overlayTitle = document.getElementById('overlay-title');
const hudEl = document.getElementById('hud');
document.getElementById('restart-btn').addEventListener('click', init);

// ─── Responsive scaling ───────────────────────────────────────────────────────
// The canvas internal resolution stays at CANVAS_W×CANVAS_H.
// We scale the CSS display size to fit the viewport, and compensate in event coords.
function resize() {
  const gap = 8;
  const maxW = window.innerWidth;
  const maxH = window.innerHeight - hudEl.offsetHeight - gap * 2;
  const scale = Math.min(1, maxW / CANVAS_W, maxH / CANVAS_H);
  const w = Math.floor(CANVAS_W * scale);
  const h = Math.floor(CANVAS_H * scale);
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
  hudEl.style.width   = w + 'px';
}
window.addEventListener('resize', resize);

// Convert a CSS-space point on the canvas to logical game coordinates
function toLogical(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (CANVAS_W / rect.width),
    y: (clientY - rect.top)  * (CANVAS_H / rect.height),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function rowOffset(row) { return (row % 2 === 1) ? R : 0; }

function bubbleXY(row, col) {
  return {
    x: MARGIN + rowOffset(row) + col * DIAM + R,
    y: TOP + row * ROW_H,
  };
}

function dist(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function getNeighbors(row, col) {
  const parity = row % 2 === 0 ? 'even' : 'odd';
  return NEIGHBORS[parity]
    .map(([dr, dc]) => [row + dr, col + dc])
    .filter(([r, c]) => r >= 0 && r < ROWS && c >= 0 && c < COLS);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));

  // Populate initial rows – leave a small gap at bottom of initial rows for playability
  for (let r = 0; r < INIT_ROWS; r++) {
    const cols = r % 2 === 0 ? COLS : COLS - 1; // odd rows are 1 shorter (offset)
    for (let c = 0; c < cols; c++) {
      grid[r][c] = rand(COLORS);
    }
  }

  flying = null;
  cannonAngle = 0;
  score = 0;
  gameOver = false;
  pops = [];
  nextColor = rand(COLORS);
  overlay.classList.add('hidden');
  scoreEl.textContent = '0';
  drawNextBubble();

  if (!window._loopStarted) {
    window._loopStarted = true;
    let last = null;
    function loop(ts) {
      const dt = last ? Math.min((ts - last) / 1000, 0.05) : 0;
      last = ts;
      if (!gameOver) update(dt);
      draw();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }
}

// ─── Update ───────────────────────────────────────────────────────────────────
function update(dt) {
  // Advance pop animations
  for (const p of pops) {
    p.r += 40 * dt;
    p.alpha -= 2.5 * dt;
  }
  pops = pops.filter(p => p.alpha > 0);

  if (!flying) return;

  flying.x += flying.vx * dt;
  flying.y += flying.vy * dt;

  // Wall bounce
  if (flying.x - R < 0) { flying.x = R; flying.vx = Math.abs(flying.vx); }
  if (flying.x + R > CANVAS_W) { flying.x = CANVAS_W - R; flying.vx = -Math.abs(flying.vx); }

  // Flew off top (shouldn't happen normally, but safety)
  if (flying.y - R < 0) {
    flying.y = R;
    snapAndPlace();
    return;
  }

  // Collision with grid bubbles or top boundary
  if (checkCollision()) {
    snapAndPlace();
  }
}

function checkCollision() {
  // Hit top of grid area
  if (flying.y - R <= TOP + ROW_H * 0.5) return true;

  // Hit any existing bubble
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!grid[r][c]) continue;
      const { x, y } = bubbleXY(r, c);
      if (dist(flying.x, flying.y, x, y) < DIAM * 0.95) return true;
    }
  }
  return false;
}

function snapAndPlace() {
  // Find the best empty grid cell closest to flying bubble's position
  let bestR = -1, bestC = -1, bestDist = Infinity;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[r][c] !== null) continue;
      // Only consider cells adjacent to existing bubbles OR top row
      if (r > 0 && !hasFilledNeighbor(r, c)) continue;
      const { x, y } = bubbleXY(r, c);
      const d = dist(flying.x, flying.y, x, y);
      if (d < bestDist) { bestDist = d; bestR = r; bestC = c; }
    }
  }

  // Fallback: any empty top-row cell
  if (bestR === -1) {
    for (let c = 0; c < COLS; c++) {
      if (!grid[0][c]) { bestR = 0; bestC = c; break; }
    }
  }

  if (bestR === -1) { flying = null; return; } // grid full in area

  grid[bestR][bestC] = flying.color;
  flying = null;

  const matched = floodFill(bestR, bestC, grid[bestR][bestC]);
  if (matched.length >= 3) {
    for (const [r, c] of matched) {
      const { x, y } = bubbleXY(r, c);
      pops.push({ x, y, r: R, alpha: 1, color: grid[r][c] });
      grid[r][c] = null;
    }
    score += matched.length * 10;

    // Remove orphans
    const orphans = findOrphans();
    for (const [r, c] of orphans) {
      const { x, y } = bubbleXY(r, c);
      pops.push({ x, y, r: R, alpha: 1, color: grid[r][c] });
      grid[r][c] = null;
    }
    score += orphans.length * 20;
    scoreEl.textContent = score;
  }

  // Check game over: any bubble below the "danger" line
  const dangerY = CANNON_Y - R * 3;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[r][c]) {
        const { y } = bubbleXY(r, c);
        if (y + R >= dangerY) {
          triggerGameOver();
          return;
        }
      }
    }
  }

  nextColor = rand(COLORS);
  drawNextBubble();
}

function hasFilledNeighbor(row, col) {
  return getNeighbors(row, col).some(([r, c]) => grid[r][c] !== null);
}

// BFS flood fill – returns array of [r,c] with same color connected to (row,col)
function floodFill(row, col, color) {
  const visited = new Set();
  const key = (r, c) => `${r},${c}`;
  const queue = [[row, col]];
  visited.add(key(row, col));
  while (queue.length) {
    const [r, c] = queue.shift();
    for (const [nr, nc] of getNeighbors(r, c)) {
      if (!visited.has(key(nr, nc)) && grid[nr][nc] === color) {
        visited.add(key(nr, nc));
        queue.push([nr, nc]);
      }
    }
  }
  return [...visited].map(k => k.split(',').map(Number));
}

// BFS from top row to find all reachable bubbles; return unreachable ones (orphans)
function findOrphans() {
  const visited = new Set();
  const key = (r, c) => `${r},${c}`;
  const queue = [];

  for (let c = 0; c < COLS; c++) {
    if (grid[0][c]) {
      visited.add(key(0, c));
      queue.push([0, c]);
    }
  }

  while (queue.length) {
    const [r, c] = queue.shift();
    for (const [nr, nc] of getNeighbors(r, c)) {
      if (!visited.has(key(nr, nc)) && grid[nr][nc]) {
        visited.add(key(nr, nc));
        queue.push([nr, nc]);
      }
    }
  }

  const orphans = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[r][c] && !visited.has(key(r, c))) {
        orphans.push([r, c]);
      }
    }
  }
  return orphans;
}

function triggerGameOver() {
  gameOver = true;
  overlayTitle.textContent = 'GAME OVER';
  overlayScore.textContent = `Final Score: ${score}`;
  overlay.classList.remove('hidden');
}

// ─── Shoot ────────────────────────────────────────────────────────────────────
function shoot() {
  if (flying || gameOver) return;
  const vx = Math.sin(cannonAngle) * BUBBLE_SPEED;
  const vy = -Math.cos(cannonAngle) * BUBBLE_SPEED;
  flying = { x: CANNON_X, y: CANNON_Y, vx, vy, color: nextColor };
  nextColor = rand(COLORS);
  drawNextBubble();
}

// ─── Draw ─────────────────────────────────────────────────────────────────────
function draw() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // Draw danger line
  const dangerY = CANNON_Y - R * 3;
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = 'rgba(231,76,60,0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, dangerY);
  ctx.lineTo(CANVAS_W, dangerY);
  ctx.stroke();
  ctx.restore();

  // Grid bubbles
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[r][c]) {
        const { x, y } = bubbleXY(r, c);
        drawBubble(ctx, x, y, R, grid[r][c]);
      }
    }
  }

  // Pop animations
  for (const p of pops) {
    ctx.save();
    ctx.globalAlpha = p.alpha;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }

  // Aim guide
  if (!flying && !gameOver) drawAimGuide();

  // Cannon
  drawCannon();

  // Flying bubble
  if (flying) drawBubble(ctx, flying.x, flying.y, R, flying.color);
}

function drawBubble(context, x, y, radius, color) {
  // Shadow / glow
  context.save();
  context.shadowColor = color;
  context.shadowBlur = 8;

  // Main circle
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  const grad = context.createRadialGradient(x - radius * 0.3, y - radius * 0.3, radius * 0.1, x, y, radius);
  grad.addColorStop(0, lighten(color, 60));
  grad.addColorStop(1, color);
  context.fillStyle = grad;
  context.fill();

  // Outline
  context.strokeStyle = 'rgba(0,0,0,0.2)';
  context.lineWidth = 1.5;
  context.stroke();

  // Shine
  context.beginPath();
  context.arc(x - radius * 0.28, y - radius * 0.28, radius * 0.22, 0, Math.PI * 2);
  context.fillStyle = 'rgba(255,255,255,0.35)';
  context.fill();
  context.restore();
}

function lighten(hex, amount) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, (num >> 16) + amount);
  const g = Math.min(255, ((num >> 8) & 0xff) + amount);
  const b = Math.min(255, (num & 0xff) + amount);
  return `rgb(${r},${g},${b})`;
}

function drawCannon() {
  const tipX = CANNON_X + Math.sin(cannonAngle) * CANNON_LEN;
  const tipY = CANNON_Y - Math.cos(cannonAngle) * CANNON_LEN;

  ctx.save();
  ctx.strokeStyle = '#95a5a6';
  ctx.lineWidth = 12;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(CANNON_X, CANNON_Y);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  ctx.strokeStyle = '#bdc3c7';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(CANNON_X, CANNON_Y);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  // Base circle
  ctx.beginPath();
  ctx.arc(CANNON_X, CANNON_Y, 18, 0, Math.PI * 2);
  ctx.fillStyle = '#7f8c8d';
  ctx.fill();
  ctx.strokeStyle = '#95a5a6';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}

function drawAimGuide() {
  // Simulate the trajectory dotted line (with wall bounces)
  ctx.save();
  ctx.setLineDash([5, 8]);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  let x = CANNON_X;
  let y = CANNON_Y;
  let vx = Math.sin(cannonAngle);
  let vy = -Math.cos(cannonAngle);
  const step = 8;
  const maxSteps = 120;

  ctx.moveTo(x, y);
  for (let i = 0; i < maxSteps; i++) {
    x += vx * step;
    y += vy * step;
    if (x - R < 0) { x = R; vx = Math.abs(vx); }
    if (x + R > CANVAS_W) { x = CANVAS_W - R; vx = -Math.abs(vx); }
    ctx.lineTo(x, y);
    if (y < TOP) break;
  }
  ctx.stroke();
  ctx.restore();
}

function drawNextBubble() {
  nextCtx.clearRect(0, 0, 44, 44);
  drawBubble(nextCtx, 22, 22, R, nextColor);
}

// ─── Events ───────────────────────────────────────────────────────────────────
function updateAngle(clientX, clientY) {
  const { x, y } = toLogical(clientX, clientY);
  let angle = Math.atan2(x - CANNON_X, -(y - CANNON_Y));
  cannonAngle = clamp(angle, -Math.PI * 0.85, Math.PI * 0.85);
}

canvas.addEventListener('mousemove', e => updateAngle(e.clientX, e.clientY));
canvas.addEventListener('click', shoot);

// Touch: drag to aim, release to shoot
canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  updateAngle(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: false });

canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  updateAngle(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: false });

canvas.addEventListener('touchend', e => {
  e.preventDefault();
  shoot();
}, { passive: false });

// ─── Start ────────────────────────────────────────────────────────────────────
init();
resize();
