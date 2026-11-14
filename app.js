/**
 * School Dismissal Management System (SDMS) — Classroom Monitor Frontend
 * Separate GitHub Pages Repository; connects to shared Google Apps Script Web App (Code.gs).
 */

const CONFIG = {
  // Replace with your deployed Google Apps Script Web App URL:
  API_URL: 'https://script.google.com/macros/s/AKfycbwuhV1WDETx0R8-MMFaBiXjEkdDCq_jsGH49ALedQuhP6ALcibfC4i9-g6hCMHdCcWu/exec',
  POLL_INTERVAL_MS: 3500, // 3.5s polling (shares GAS 3s cache cleanly)

  // Dynamic squarish tile sizing parameters (in pixels)
  TILE_MAX_SIZE: 215,
  TILE_MIN_SIZE: 136, // Floor below which tiles stop shrinking & scroll vertically
  TILE_ASPECT_RATIO: 0.92, // height / width ratio for squarish proportions
  TILE_GAP: 10,
  TILE_PADDING: 10
};

// Exact left-to-right panel order on the Start Screen
const GRADE_PANELS = ['preK', 'K', '1', '2', '3', '4', '5'];

const STATE = {
  view: 'start', // 'start' | 'monitor'
  filterType: 'grade', // 'grade' | 'class'
  filterValue: '',
  students: [],
  activeBuses: [],
  mruBuses: [],
  knownVisibleIds: new Set(),
  recentNewIds: new Set(),
  knownActiveBuses: new Set(),
  recentNewBuses: new Set(),
  hasInitializedMonitorTracking: false,
  soundEnabled: true,
  audioCtx: null,
  inFlightWrites: 0,
  retryQueue: [],
  isDemoMode: false
};

/* ==========================================================================
   INITIALIZATION & POLLING LOOP
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  bindHeaderEvents();
  setupResizeObservers();

  const apiUrl = String(CONFIG.API_URL || '').trim();
  if (!apiUrl || apiUrl === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') {
    STATE.isDemoMode = true;
    showStatusBanner('Demo Mode Active — Paste your Google Apps Script Web App URL into app.js (CONFIG.API_URL) for live Google Sheets sync.');
    loadDemoData();
    renderAll();
  } else {
    // Render the 7 grade panels and 'Whole Grade' buttons immediately while fetching live data
    renderAll();
    fetchLatestState();
  }

  // Poll backend every 3.5 seconds
  setInterval(() => {
    if (STATE.isDemoMode) return;
    flushRetryQueue();
    fetchLatestState();
  }, CONFIG.POLL_INTERVAL_MS);

  // Refresh whole-minute counters every 5 seconds
  setInterval(() => {
    if (STATE.view === 'monitor') {
      updateWholeMinuteBadges();
    }
  }, 5000);
});

function showStatusBanner(message) {
  const banner = document.getElementById('demo-banner');
  if (!banner) return;
  banner.textContent = message;
  banner.classList.remove('hidden');
}

function hideStatusBanner() {
  if (STATE.isDemoMode) return;
  const banner = document.getElementById('demo-banner');
  if (banner) banner.classList.add('hidden');
}

function bindHeaderEvents() {
  document.getElementById('btn-back-start').addEventListener('click', () => {
    STATE.view = 'start';
    STATE.hasInitializedMonitorTracking = false;
    STATE.knownVisibleIds.clear();
    STATE.recentNewIds.clear();
    STATE.knownActiveBuses.clear();
    STATE.recentNewBuses.clear();

    document.getElementById('btn-back-start').classList.add('hidden');
    document.getElementById('header-title').textContent = 'DISMISSAL';
    document.getElementById('header-subtitle').classList.add('hidden');

    document.getElementById('screen-monitor').classList.add('hidden');
    document.getElementById('screen-start').classList.remove('hidden');
    renderStartScreen();
  });

  document.getElementById('btn-sound-toggle').addEventListener('click', () => {
    STATE.soundEnabled = !STATE.soundEnabled;
    const btn = document.getElementById('btn-sound-toggle');
    btn.textContent = STATE.soundEnabled ? '🔔 Chime On' : '🔇 Muted';
    btn.classList.toggle('muted', !STATE.soundEnabled);
    if (STATE.soundEnabled) {
      unlockAudioContext();
      playPleasantNotificationChime();
    }
  });
}

function setupResizeObservers() {
  const valetGrid = document.getElementById('valet-grid');
  const pickupGrid = document.getElementById('pickup-grid');

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (STATE.view === 'monitor') {
        applyDynamicTileSizing(valetGrid);
        applyDynamicTileSizing(pickupGrid);
      }
    });
    ro.observe(valetGrid);
    ro.observe(pickupGrid);
  } else {
    window.addEventListener('resize', () => {
      if (STATE.view === 'monitor') {
        applyDynamicTileSizing(valetGrid);
        applyDynamicTileSizing(pickupGrid);
      }
    });
  }
}

/* ==========================================================================
   BACKEND API SYNC & LOCATION WRITES
   ========================================================================== */
async function fetchLatestState() {
  if (STATE.inFlightWrites > 0 || STATE.retryQueue.length > 0) {
    return;
  }

  try {
    const url = `${CONFIG.API_URL}?client=classroom&action=state&t=${Date.now()}`;
    const res = await fetch(url, { method: 'GET' });
    const json = await res.json();

    if (json && json.ok && json.data) {
      hideStatusBanner();
      applyServerState(json.data);
      updateSyncBadge(true);
    } else {
      const errMsg = (json && json.error) ? json.error : 'Unknown backend response';
      if (errMsg.toLowerCase().includes('unauthorized')) {
        showStatusBanner('Backend Authorization Error: In Google Apps Script, go to Deploy > Manage deployments > Edit > Version: New version > Deploy so the updated Code.gs goes live.');
      } else {
        showStatusBanner(`Sync Notice: ${errMsg}`);
      }
      updateSyncBadge(false);
    }
  } catch (err) {
    showStatusBanner('Unable to reach Google Apps Script Web App. Verify CONFIG.API_URL and confirm Web App access is set to "Anyone".');
    updateSyncBadge(false);
  }
}

function applyServerState(data) {
  STATE.students = Array.isArray(data.students) ? data.students : [];
  STATE.activeBuses = Array.isArray(data.activeBuses) ? data.activeBuses : [];
  STATE.mruBuses = Array.isArray(data.mruBuses) ? data.mruBuses : [];
  renderAll();
}

function updateSyncBadge(isHealthy) {
  const badge = document.getElementById('sync-badge');
  if (STATE.isDemoMode) {
    badge.className = 'sync-badge sync-warn';
    badge.textContent = 'Demo Mode';
    return;
  }

  if (STATE.retryQueue.length > 0) {
    badge.className = 'sync-badge sync-warn';
    badge.textContent = `Reconnecting (${STATE.retryQueue.length})`;
  } else if (isHealthy) {
    badge.className = 'sync-badge sync-live';
    badge.textContent = 'Live • Synced';
  } else {
    badge.className = 'sync-badge sync-warn';
    badge.textContent = 'Syncing...';
  }
}

async function sendLocationUpdate(rowIndex, locationValue) {
  if (STATE.isDemoMode) {
    return;
  }

  const payload = {
    client: 'classroom',
    action: 'updateLocation',
    rowIndex: rowIndex,
    location: locationValue
  };

  STATE.inFlightWrites++;
  try {
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    STATE.inFlightWrites = Math.max(0, STATE.inFlightWrites - 1);

    if (json && json.ok && json.data) {
      if (STATE.inFlightWrites === 0 && STATE.retryQueue.length === 0) {
        applyServerState(json.data);
      }
      updateSyncBadge(true);
    } else {
      throw new Error((json && json.error) || 'Failed to update location');
    }
  } catch (err) {
    STATE.inFlightWrites = Math.max(0, STATE.inFlightWrites - 1);
    STATE.retryQueue.push(payload);
    updateSyncBadge(false);
  }
}

async function flushRetryQueue() {
  if (STATE.retryQueue.length === 0 || STATE.inFlightWrites > 0) return;
  const next = STATE.retryQueue.shift();
  updateSyncBadge(false);
  await sendLocationUpdate(next.rowIndex, next.location);
}

/* ==========================================================================
   SCREEN 1: 7-PANEL START SCREEN (preK, K, 1, 2, 3, 4, 5)
   ========================================================================== */
function extractClassPrefix(classInfo) {
  const raw = String(classInfo || '').trim();
  if (!raw) return '';
  const sepIdx = raw.indexOf(' - ');
  return (sepIdx !== -1 ? raw.slice(0, sepIdx) : raw).trim();
}

function getTeachersForGrade(grade) {
  const teacherSet = new Set();
  const targetGrade = String(grade).trim().toLowerCase();

  STATE.students.forEach((st) => {
    if (String(st.grade || '').trim().toLowerCase() === targetGrade) {
      const teacher = extractClassPrefix(st.classInfo);
      if (teacher) teacherSet.add(teacher);
    }
  });
  return Array.from(teacherSet).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function countActiveStudentsForTeacher(teacherName) {
  return STATE.students.filter((st) => {
    if (st.status !== 'Needed at Valet' && st.status !== 'Needed at Pick Up Door') {
      return false;
    }
    return extractClassPrefix(st.classInfo) === teacherName;
  }).length;
}

function renderStartScreen() {
  const container = document.getElementById('grade-panels-container');
  container.innerHTML = '';

  GRADE_PANELS.forEach((grade) => {
    const panel = document.createElement('section');
    panel.className = `grade-panel grade-panel-${grade}`;

    // Grade Header
    const header = document.createElement('div');
    header.className = 'grade-panel-header';
    const h2 = document.createElement('h2');
    h2.textContent = grade;
    header.appendChild(h2);

    // Teacher Buttons List for this Grade Level
    const teacherList = document.createElement('div');
    teacherList.className = 'teacher-buttons-list';

    const teachers = getTeachersForGrade(grade);
    if (teachers.length === 0) {
      const note = document.createElement('div');
      note.className = 'no-teachers-note';
      note.textContent = STATE.students.length === 0 ? 'Loading classes...' : 'No classes listed';
      teacherList.appendChild(note);
    } else {
      teachers.forEach((teacher) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'teacher-btn';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'teacher-btn-name';
        nameSpan.textContent = teacher;
        btn.appendChild(nameSpan);

        const activeCount = countActiveStudentsForTeacher(teacher);
        if (activeCount > 0) {
          const dot = document.createElement('span');
          dot.className = 'teacher-active-dot';
          dot.textContent = activeCount;
          btn.appendChild(dot);
        }

        btn.addEventListener('click', () => {
          const gradeLabel = grade === 'preK' || grade === 'K' ? grade : `Grade ${grade}`;
          openMonitorView('class', teacher, `${teacher} (${gradeLabel})`);
        });

        teacherList.appendChild(btn);
      });
    }

    // Bottom 'Whole Grade' Button
    const wholeGradeBtn = document.createElement('button');
    wholeGradeBtn.type = 'button';
    wholeGradeBtn.className = `whole-grade-btn whole-grade-${grade}`;
    wholeGradeBtn.textContent = 'Whole Grade';
    wholeGradeBtn.addEventListener('click', () => {
      const gradeLabel = grade === 'preK' || grade === 'K' ? `${grade} — Whole Grade` : `Grade ${grade} — Whole Grade`;
      openMonitorView('grade', grade, gradeLabel);
    });

    panel.append(header, teacherList, wholeGradeBtn);
    container.appendChild(panel);
  });
}

function openMonitorView(filterType, filterValue, displayTitle) {
  unlockAudioContext();

  STATE.view = 'monitor';
  STATE.filterType = filterType;
  STATE.filterValue = filterValue;
  STATE.hasInitializedMonitorTracking = false;
  STATE.knownVisibleIds.clear();
  STATE.recentNewIds.clear();
  STATE.knownActiveBuses.clear();
  STATE.recentNewBuses.clear();

  document.getElementById('btn-back-start').classList.remove('hidden');
  document.getElementById('header-title').textContent = 'DISMISSAL';

  const subtitle = document.getElementById('header-subtitle');
  subtitle.textContent = displayTitle || filterValue;
  subtitle.classList.remove('hidden');

  document.getElementById('screen-start').classList.add('hidden');
  document.getElementById('screen-monitor').classList.remove('hidden');

  renderMonitorScreen();
}

/* ==========================================================================
   SCREEN 2: THREE-PANEL MONITOR (BUSES, NEEDED AT VALET, NEEDED AT PICK UP DOOR)
   ========================================================================== */
function renderMonitorScreen() {
  const matchingStudents = STATE.students.filter((st) => {
    if (STATE.filterType === 'grade') {
      return String(st.grade || '').trim().toLowerCase() === String(STATE.filterValue).trim().toLowerCase();
    }
    if (STATE.filterType === 'class') {
      return extractClassPrefix(st.classInfo) === STATE.filterValue;
    }
    return true;
  });

  const valetStudents = matchingStudents
    .filter((st) => st.status === 'Needed at Valet')
    .sort(compareStudentsByLastThenFirst);

  const pickupStudents = matchingStudents
    .filter((st) => st.status === 'Needed at Pick Up Door')
    .sort(compareStudentsByLastThenFirst);

  // Track newly appeared student tiles AND newly added buses
  const currentVisibleIds = new Set();
  valetStudents.forEach((s) => currentVisibleIds.add(s.rowIndex));
  pickupStudents.forEach((s) => currentVisibleIds.add(s.rowIndex));

  const currentBusSet = new Set(STATE.activeBuses);

  if (!STATE.hasInitializedMonitorTracking) {
    STATE.knownVisibleIds = currentVisibleIds;
    STATE.knownActiveBuses = currentBusSet;
    STATE.hasInitializedMonitorTracking = true;
  } else {
    let shouldChime = false;

    currentVisibleIds.forEach((rowIdx) => {
      if (!STATE.knownVisibleIds.has(rowIdx)) {
        shouldChime = true;
        STATE.recentNewIds.add(rowIdx);
        setTimeout(() => {
          STATE.recentNewIds.delete(rowIdx);
        }, 2000);
      }
    });

    currentBusSet.forEach((busStr) => {
      if (!STATE.knownActiveBuses.has(busStr)) {
        shouldChime = true;
        STATE.recentNewBuses.add(busStr);
        setTimeout(() => {
          STATE.recentNewBuses.delete(busStr);
        }, 2000);
      }
    });

    STATE.knownVisibleIds = currentVisibleIds;
    STATE.knownActiveBuses = currentBusSet;

    if (shouldChime) {
      playPleasantNotificationChime();
    }
  }

  updateBusesPanelWidth();
  renderCalledBusesPanel();

  document.getElementById('count-valet').textContent = valetStudents.length;
  document.getElementById('count-pickup').textContent = pickupStudents.length;

  renderStudentTilesPanel('valet-grid', valetStudents, 'No students currently needed at Valet.');
  renderStudentTilesPanel('pickup-grid', pickupStudents, 'No students currently needed at Pick Up Door.');
}

function updateBusesPanelWidth() {
  const panelEl = document.getElementById('panel-buses');
  const candidateStrings = STATE.mruBuses.length > 0 ? STATE.mruBuses : STATE.activeBuses;

  const canvas = updateBusesPanelWidth._canvas || (updateBusesPanelWidth._canvas = document.createElement('canvas'));
  const ctx = canvas.getContext('2d');
  ctx.font = '800 16.32px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  let maxTextWidth = 0;
  candidateStrings.forEach((str) => {
    const w = ctx.measureText(String(str || '')).width;
    if (w > maxTextWidth) maxTextWidth = w;
  });

  const horizontalChrome = 54;
  const computedPanelWidth = Math.max(150, Math.ceil(maxTextWidth + horizontalChrome));
  panelEl.style.width = `${computedPanelWidth}px`;
}

function renderCalledBusesPanel() {
  const listEl = document.getElementById('buses-list');
  document.getElementById('count-buses').textContent = STATE.activeBuses.length;
  listEl.innerHTML = '';

  if (STATE.activeBuses.length === 0) {
    listEl.innerHTML = '<div class="empty-buses">No buses called yet</div>';
    return;
  }

  STATE.activeBuses.forEach((busText) => {
    const pill = document.createElement('div');
    const isNewBus = STATE.recentNewBuses.has(busText);
    pill.className = `bus-pill ${isNewBus ? 'bus-new-pulse' : ''}`.trim();
    pill.textContent = busText;
    listEl.appendChild(pill);
  });
}

function renderStudentTilesPanel(gridId, students, emptyMessage) {
  const gridEl = document.getElementById(gridId);
  gridEl.innerHTML = '';

  if (students.length === 0) {
    gridEl.style.gridTemplateColumns = '1fr';
    gridEl.style.gridAutoRows = 'auto';
    gridEl.style.overflowY = 'hidden';
    gridEl.innerHTML = `<div class="empty-panel-state">${emptyMessage}</div>`;
    return;
  }

  students.forEach((st) => {
    const tile = createStudentTileElement(st);
    gridEl.appendChild(tile);
  });

  applyDynamicTileSizing(gridEl);
}

function applyDynamicTileSizing(gridEl) {
  const count = gridEl.querySelectorAll('.student-tile').length;
  if (count === 0) return;

  const rect = gridEl.getBoundingClientRect();
  const availW = Math.max(160, rect.width - CONFIG.TILE_PADDING * 2);
  const availH = Math.max(160, rect.height - CONFIG.TILE_PADDING * 2);
  const gap = CONFIG.TILE_GAP;
  const minSize = CONFIG.TILE_MIN_SIZE;
  const maxSize = CONFIG.TILE_MAX_SIZE;
  const ratio = CONFIG.TILE_ASPECT_RATIO;

  const maxPossibleCols = Math.max(1, Math.floor((availW + gap) / (minSize + gap)));
  let bestCols = 1;
  let bestSize = 0;

  for (let cols = 1; cols <= maxPossibleCols; cols++) {
    const rows = Math.ceil(count / cols);
    const wPerTile = (availW - gap * (cols - 1)) / cols;
    const hPerTile = (availH - gap * (rows - 1)) / rows;
    const candidateSize = Math.min(wPerTile, hPerTile / ratio, maxSize);

    if (candidateSize > bestSize) {
      bestSize = candidateSize;
      bestCols = cols;
    }
  }

  if (bestSize >= minSize) {
    const tileH = Math.round(bestSize * ratio);
    gridEl.style.gridTemplateColumns = `repeat(${bestCols}, minmax(0, 1fr))`;
    gridEl.style.gridAutoRows = `${tileH}px`;
    gridEl.style.overflowY = 'hidden';
  } else {
    const floorCols = maxPossibleCols;
    const floorTileH = Math.round(minSize * ratio);
    gridEl.style.gridTemplateColumns = `repeat(${floorCols}, minmax(0, 1fr))`;
    gridEl.style.gridAutoRows = `${floorTileH}px`;
    gridEl.style.overflowY = 'auto';
  }
}

function createStudentTileElement(student) {
  const isOnWay = student.location === 'On the Way';
  const isNew = STATE.recentNewIds.has(student.rowIndex);

  const tile = document.createElement('div');
  tile.className = [
    'student-tile',
    isOnWay ? 'tile-on-way' : '',
    isNew ? 'tile-new-pulse' : ''
  ].filter(Boolean).join(' ');
  tile.dataset.rowIndex = student.rowIndex;

  const topRow = document.createElement('div');
  topRow.className = 'tile-top';

  const namesCol = document.createElement('div');
  namesCol.className = 'tile-names';

  const firstEl = document.createElement('span');
  firstEl.className = 'tile-name-first';
  firstEl.textContent = student.first;

  const lastEl = document.createElement('span');
  lastEl.className = 'tile-name-last';
  lastEl.textContent = student.last;

  namesCol.append(firstEl, lastEl);

  const wholeMins = getWholeElapsedMinutes(student.time);
  const minBadge = document.createElement('span');
  minBadge.className = getMinuteBadgeClass(wholeMins);
  minBadge.dataset.isoTime = student.time || '';
  minBadge.textContent = `${wholeMins}m`;

  topRow.append(namesCol, minBadge);

  const bottomRow = document.createElement('div');
  bottomRow.className = 'tile-checkboxes';

  const options = [
    { value: 'Bus', label: 'Bus', checkedClass: 'checked-bus' },
    { value: 'Aftercare', label: 'Aftercare', checkedClass: 'checked-aftercare' },
    { value: 'On the Way', label: 'On the Way', checkedClass: 'checked-onway' }
  ];

  options.forEach((opt) => {
    const isChecked = student.location === opt.value;
    const label = document.createElement('label');
    label.className = `loc-option ${isChecked ? opt.checkedClass : ''}`.trim();

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = isChecked;

    cb.addEventListener('change', () => {
      const nextLocation = cb.checked ? opt.value : '';
      student.location = nextLocation;

      renderMonitorScreen();
      sendLocationUpdate(student.rowIndex, nextLocation);
    });

    const text = document.createElement('span');
    text.textContent = opt.label;

    label.append(cb, text);
    bottomRow.appendChild(label);
  });

  tile.append(topRow, bottomRow);
  return tile;
}

/* ==========================================================================
   WHOLE-MINUTE COUNTER HELPERS
   ========================================================================== */
function getTimestampMs(isoString) {
  if (!isoString) return 0;
  const str = String(isoString).trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str)
    ? str.replace(' ', 'T')
    : str;

  const parsed = Date.parse(normalized);
  if (!isNaN(parsed)) return parsed;

  const match = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (match) {
    let hours = Number(match[1]);
    const mins = Number(match[2]);
    const secs = Number(match[3] || 0);
    const meridiem = (match[4] || '').toUpperCase();
    if (meridiem === 'PM' && hours < 12) hours += 12;
    if (meridiem === 'AM' && hours === 12) hours = 0;
    const d = new Date();
    d.setHours(hours, mins, secs, 0);
    return d.getTime();
  }

  return 0;
}

function getWholeElapsedMinutes(isoString) {
  const startMs = getTimestampMs(isoString);
  if (!startMs) return 0;
  const elapsedSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  return Math.floor(elapsedSec / 60);
}

function getMinuteBadgeClass(wholeMinutes) {
  if (wholeMinutes >= 10) return 'tile-minutes min-alert';
  if (wholeMinutes >= 5) return 'tile-minutes min-warn';
  return 'tile-minutes';
}

function updateWholeMinuteBadges() {
  document.querySelectorAll('.tile-minutes').forEach((badge) => {
    const mins = getWholeElapsedMinutes(badge.dataset.isoTime);
    badge.textContent = `${mins}m`;
    badge.className = getMinuteBadgeClass(mins);
  });
}

/* ==========================================================================
   PLEASANT WEB AUDIO NOTIFICATION CHIME
   ========================================================================== */
function unlockAudioContext() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!STATE.audioCtx) {
      STATE.audioCtx = new AudioContextClass();
    }
    if (STATE.audioCtx.state === 'suspended') {
      STATE.audioCtx.resume();
    }
  } catch (e) {}
}

function playPleasantNotificationChime() {
  if (!STATE.soundEnabled) return;
  try {
    unlockAudioContext();
    const ctx = STATE.audioCtx;
    if (!ctx) return;

    const now = ctx.currentTime;
    const notes = [
      { freq: 659.25, start: 0.0, duration: 0.45, gain: 0.14 },
      { freq: 880.00, start: 0.14, duration: 0.65, gain: 0.16 }
    ];

    notes.forEach((n) => {
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.freq, now + n.start);

      gainNode.gain.setValueAtTime(0.0001, now + n.start);
      gainNode.gain.exponentialRampToValueAtTime(n.gain, now + n.start + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + n.start + n.duration);

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);

      osc.start(now + n.start);
      osc.stop(now + n.start + n.duration + 0.05);
    });
  } catch (e) {}
}

/* ==========================================================================
   SHARED RENDER & SORTING
   ========================================================================== */
function renderAll() {
  if (STATE.view === 'start') {
    renderStartScreen();
  } else {
    renderMonitorScreen();
  }
}

function compareStudentsByLastThenFirst(a, b) {
  const lastCmp = a.last.localeCompare(b.last, undefined, { sensitivity: 'base' });
  if (lastCmp !== 0) return lastCmp;
  return a.first.localeCompare(b.first, undefined, { sensitivity: 'base' });
}

/* ==========================================================================
   DEMO SANDBOX DATA (USED ONLY BEFORE GOOGLE APPS SCRIPT URL IS CONFIGURED)
   ========================================================================== */
function loadDemoData() {
  const now = Date.now();
  const isoAgo = (sec) => new Date(now - sec * 1000).toISOString();

  STATE.activeBuses = ['74-GYM', '81-CAFE', '77-SPANISH/O204'];
  STATE.mruBuses = [
    '74-GYM',
    '81-CAFE',
    '77-SPANISH/O204',
    '78-DESIGN/RED Maker',
    'Reign- Valet',
    '76-CAFE',
    'AC-pk/k-ART',
    '82-GYM'
  ];

  STATE.students = [
    { rowIndex: 2, first: 'Lucas', last: 'Davis', classInfo: 'Hall - 4101', status: 'Needed at Pick Up Door', grade: 'preK', time: isoAgo(90), mode: '', location: '' },
    { rowIndex: 3, first: 'Maya', last: 'Brooks', classInfo: 'Grant - 4102', status: 'waiting', grade: 'preK', time: '', mode: '', location: '' },
    { rowIndex: 4, first: 'Lily', last: 'Allen', classInfo: 'Davis - 4112', status: 'Needed at Valet', grade: 'K', time: isoAgo(135), mode: '', location: '' },
    { rowIndex: 5, first: 'Owen', last: 'Reed', classInfo: 'Patel - 4114', status: 'waiting', grade: 'K', time: '', mode: '', location: '' },
    { rowIndex: 6, first: 'Ava', last: 'Miller', classInfo: 'Young - 4110', status: 'Needed at Valet', grade: '1', time: isoAgo(495), mode: '', location: 'Bus' },
    { rowIndex: 7, first: 'Caleb', last: 'Hayes', classInfo: 'Lopez - 4105', status: 'waiting', grade: '1', time: '', mode: '', location: '' },
    { rowIndex: 8, first: 'Noah', last: 'Adams', classInfo: 'Miller - 4108', status: 'waiting', grade: '2', time: '', mode: '74', location: '' },
    { rowIndex: 9, first: 'Ethan', last: 'Carter', classInfo: 'Miller - 4108', status: 'Needed at Valet', grade: '2', time: isoAgo(45), mode: '', location: '' },
    { rowIndex: 10, first: 'Sofia', last: 'Chen', classInfo: 'White - 4302', status: 'Needed at Pick Up Door', grade: '3', time: isoAgo(255), mode: '', location: 'Aftercare' },
    { rowIndex: 11, first: 'Jaytzael', last: 'Ortiz P', classInfo: 'King - 4209', status: 'Needed at Pick Up Door', grade: '3', time: isoAgo(620), mode: '', location: '' },
    { rowIndex: 12, first: 'Mia', last: 'Baker', classInfo: 'Clark - 4201', status: 'Needed at Valet', grade: '4', time: isoAgo(320), mode: '81', location: 'On the Way' },
    { rowIndex: 13, first: 'Leo', last: 'Smith', classInfo: 'Scott - 4310', status: 'Needed at Pick Up Door', grade: '5', time: isoAgo(185), mode: '77', location: 'On the Way' }
  ];
}
