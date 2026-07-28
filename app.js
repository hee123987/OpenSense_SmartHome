// ==========================================================================
// Web Bluetooth NUS Client & Interactive Smart Home Simulator (Robust SPA)
// ==========================================================================

// NUS BLE UUIDs
const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX_UUID      = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Web -> ESP32
const NUS_TX_UUID      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // ESP32 -> Web

// BLE Connection States
let bluetoothDevice = null;
let rxCharacteristic = null;
let txCharacteristic = null;
let rxBuffer = '';

// Interaction locks to prevent slider snapping during telemetry updates
let lastLightSliderTime = 0;
let lastVolumeSliderTime = 0;
let lastWindowSliderTime = 0;
let lastModeSwitchTime = 0;

// Throttle function to limit BLE command sending rate during drag
function throttle(func, limit) {
  let inThrottle;
  return function() {
    const args = arguments;
    const context = this;
    if (!inThrottle) {
      func.apply(context, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  }
}

const sendCommandThrottled = throttle((cmd) => {
  sendCommand(cmd);
}, 150); // 150ms limit for BLE NUS transmission

// Simulation variables
let isSimulating = false;
let simInterval = null;
let simData = {
  temp: 22,
  humi: 50,
  cds: 1000,
  rain_raw: 1, // 1: dry, 0: wet
  rain_det: 0,
  pir_raw: 0,
  occupied: 0,
  state: 'WAITING',
  w_mode: 'auto',
  l_mode: 'auto',
  sound: 'ON',
  angle: 90,
  led_color: 'OFF',
  led_brightness: 0,
  volume: 100
};
let simMotionTimer = 0;
let simRainTimer = 0;

// Current local state
let currentLightBrightness = 0;

// DOM Elements - Safely queried with null checks in execution
const btnConnect = document.getElementById('btn-connect');
const connStatus = document.getElementById('conn-status');
const simToggle = document.getElementById('sim-toggle');
const terminalLog = document.getElementById('terminal-log');
const btnClearLog = document.getElementById('btn-clear-log');

// SPA Navigation Function
function navigateToScreen(screenId) {
  console.log("Navigating to screen:", screenId);
  const screens = ['home', 'window', 'light', 'settings', 'sound'];
  screens.forEach(s => {
    const el = document.getElementById(`screen-${s}`);
    if (el) {
      if (s === screenId) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    }
  });
  
  // Highlight bottom nav active state
  document.querySelectorAll('.bottom-nav .nav-item').forEach(item => {
    if (item.getAttribute('data-tab') === screenId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
}

// Initialize NeoPixel virtual LEDs (12 lights)
function initNeopixelRing() {
  const ring = document.getElementById('neopixel-ring');
  if (!ring) return;
  ring.innerHTML = '';
  for (let i = 0; i < 12; i++) {
    const led = document.createElement('div');
    led.className = 'neopixel-led';
    
    // Position the LEDs in a circle
    const angle = i * 30; // 360 / 12 = 30 deg
    led.style.transform = `rotate(${angle}deg) translateY(-42px)`;
    ring.appendChild(led);
  }
}

// Write to terminal log
function logTerminal(message, type = 'system') {
  const term = document.getElementById('terminal-log');
  if (!term) return;
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  
  let prefix = '[알림]';
  if (type === 'tx') prefix = '➔ [TX]';
  if (type === 'rx') prefix = '⬅ [RX]';
  if (type === 'error') prefix = '❌ [오류]';
  
  // Replace BLE with 블루투스 in logs
  let filteredMsg = message.replace(/BLE/g, '블루투스');
  
  line.textContent = `${time} ${prefix} ${filteredMsg}`;
  term.appendChild(line);
  term.scrollTop = term.scrollHeight;
}

// Update Light UI gauges and values (Circumference ~ 276.4)
function updateLightUI(pct, fromTelemetry = false) {
  if (fromTelemetry && Date.now() - lastLightSliderTime < 3000) {
    return; // Skip telemetry update if user recently dragged the slider
  }
  currentLightBrightness = pct;
  const slider = document.getElementById('light-brightness-slider');
  if (slider) {
    slider.value = pct;
  }
  const textVal = document.getElementById('txt-brightness-val');
  if (textVal) {
    textVal.textContent = `${pct}%`;
  }
  
  const ringFill = document.getElementById('brightness-ring-fill');
  const strokeDash = (pct / 100) * 276.4;
  if (ringFill) {
    ringFill.setAttribute('stroke-dasharray', `${strokeDash}, 276.4`);
  }
  
  // Toggle active class on brightness-radial-ring for glow effect
  const ring = document.querySelector('.brightness-radial-ring');
  if (ring) {
    if (pct > 0) {
      ring.classList.add('active');
    } else {
      ring.classList.remove('active');
    }
  }
  
  const glow = document.getElementById('radial-bulb-glow');
  if (glow) {
    const glowSpan = glow.querySelector('span');
    if (pct > 0) {
      glow.classList.add('active');
      if (glowSpan) glowSpan.style.color = 'var(--light-accent)';
    } else {
      glow.classList.remove('active');
      if (glowSpan) glowSpan.style.color = '#94a3b8';
    }
  }

  // Sync active chip selection
  document.querySelectorAll('.preset-chip-btn').forEach(btn => {
    const val = parseInt(btn.getAttribute('data-light-preset'));
    if (val === pct) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Sync status texts
  const txtRgb = document.getElementById('txt-rgb-state');
  if (txtRgb) {
    txtRgb.textContent = pct > 0 ? '켜짐' : '꺼짐';
  }
  const txtRgbDev = document.getElementById('txt-rgb-state-dev');
  if (txtRgbDev) {
    txtRgbDev.textContent = pct > 0 ? '켜짐' : '꺼짐';
  }
}

// Update Volume UI gauges and values
function updateVolumeUI(pct, fromTelemetry = false) {
  if (fromTelemetry && Date.now() - lastVolumeSliderTime < 3000) {
    return; // Skip telemetry update if user recently dragged the slider
  }
  const slider = document.getElementById('vol-slider');
  if (slider) {
    slider.value = pct;
  }
  const textVal = document.getElementById('txt-volume-val');
  if (textVal) {
    textVal.textContent = `${pct}%`;
  }
  
  const ringFill = document.getElementById('volume-ring-fill');
  const strokeDash = (pct / 100) * 276.4;
  if (ringFill) {
    ringFill.setAttribute('stroke-dasharray', `${strokeDash}, 276.4`);
  }
  
  // Volume ring glow class
  const ring = document.getElementById('volume-radial-ring');
  if (ring) {
    if (pct > 0) {
      ring.classList.add('active');
    } else {
      ring.classList.remove('active');
    }
  }
  
  const glow = document.getElementById('radial-volume-glow');
  const volumeIcon = document.getElementById('radial-volume-icon');
  if (glow) {
    if (pct > 0) {
      glow.classList.add('active');
      if (volumeIcon) {
        volumeIcon.textContent = pct > 50 ? 'volume_up' : 'volume_down';
        volumeIcon.style.color = '#0D9488';
      }
    } else {
      glow.classList.remove('active');
      if (volumeIcon) {
        volumeIcon.textContent = 'volume_off';
        volumeIcon.style.color = '#94a3b8';
      }
    }
  }
}

// Update UI from Telemetry JSON (with defensive null checks)
function updateUI(data) {
  if (!data) return;

  // 1. Temperature & Humidity (Home and Window Screens)
  if (data.temp !== null && data.temp !== undefined) {
    const txtTemp = document.getElementById('txt-temp');
    if (txtTemp) txtTemp.textContent = data.temp;
    const txtWinTemp = document.getElementById('txt-window-temp');
    if (txtWinTemp) txtWinTemp.textContent = `${data.temp}°C`;
  }
  
  if (data.humi !== null && data.humi !== undefined) {
    const txtHumi = document.getElementById('txt-humi');
    if (txtHumi) txtHumi.textContent = data.humi;
    const txtWinHumi = document.getElementById('txt-window-humi');
    if (txtWinHumi) txtWinHumi.textContent = `습도 ${data.humi}%`;
    
    // Air Comfort Badge
    const comfortLabels = { humid: '습함 (HUMID)', dry: '건조 (DRY)', good: '쾌적 (GOOD)' };
    let text = comfortLabels.good;
    let badgeClass = 'bg-green';
    
    if (data.humi > 65) {
      text = comfortLabels.humid;
      badgeClass = 'bg-blue';
    } else if (data.humi < 40) {
      text = comfortLabels.dry;
      badgeClass = 'bg-yellow';
    }
    
    const badgeAirMain = document.getElementById('badge-air-main');
    if (badgeAirMain) {
      badgeAirMain.textContent = text;
      badgeAirMain.className = 'badge ' + badgeClass;
    }
    const badgeAir = document.getElementById('badge-air');
    if (badgeAir) {
      badgeAir.textContent = text;
      badgeAir.className = 'air-card-desc badge ' + badgeClass;
    }
  }

  // 2. Light (CdS) - Settings View
  if (data.cds !== null && data.cds !== undefined) {
    const txtCds = document.getElementById('txt-cds');
    if (txtCds) txtCds.textContent = data.cds;
    
    const iconLight = document.getElementById('icon-light');
    if (iconLight) {
      if (data.cds > 1500) {
        iconLight.style.color = 'var(--light-accent)';
      } else {
        iconLight.style.color = 'var(--text-sub)';
      }
    }
    
    // Update light bar fill
    const cdsPct = Math.min(100, Math.max(0, (data.cds / 4095) * 100));
    const fill = document.getElementById('light-bar-fill');
    if (fill) fill.style.width = `${cdsPct}%`;
  }

  // 3. PIR Human Presence - Settings View
  if (data.occupied !== null && data.occupied !== undefined) {
    const badgePir = document.getElementById('badge-pir');
    if (badgePir) {
      badgePir.className = 'badge';
      if (data.occupied === 1) {
        badgePir.textContent = '감지됨 (OCCUPIED)';
        badgePir.classList.add('bg-red');
      } else {
        badgePir.textContent = '미감지 (VACANT)';
        badgePir.classList.add('bg-gray');
      }
    }
  }

  // 4. Rain Sensor - Settings View
  if (data.rain_raw !== null && data.rain_raw !== undefined) {
    const badgeRain = document.getElementById('badge-rain');
    if (badgeRain) {
      badgeRain.className = 'badge';
      if (data.rain_raw === 0) {
        badgeRain.textContent = '우천 감지 (RAIN)';
        badgeRain.classList.add('bg-blue');
      } else {
        badgeRain.textContent = '맑음 (DRY)';
        badgeRain.classList.add('bg-gray');
      }
    }
  }

  // 5. System State - Settings View
  if (data.state !== null && data.state !== undefined) {
    const oledText = document.getElementById('oled-status-text');
    if (oledText) oledText.textContent = data.state;
    
    const oledIcon = document.getElementById('oled-icon');
    if (oledIcon) oledIcon.textContent = getOledIcon(data.state);
    
    // NeoPixels
    updateVirtualNeopixels(data.state);

    // Header descriptions
    const txtWindowModeDesc = document.getElementById('txt-window-mode-desc');
    if (txtWindowModeDesc) {
      txtWindowModeDesc.textContent = getKoreanStateHeader(data.state);
    }
    
    const txtSystemState = document.getElementById('txt-system-state');
    if (txtSystemState) {
      txtSystemState.textContent = getKoreanStateLabel(data.state);
    }
    
    const systemStateBadge = document.getElementById('system-state-badge');
    if (systemStateBadge) {
      systemStateBadge.className = 'status-big-badge';
      systemStateBadge.classList.add('state-' + data.state.toLowerCase());
    }
  }

  // 6. Window Angle Slider & Mode
  if (data.w_mode) {
    const badgeWindowMode = document.getElementById('badge-window-mode');
    if (badgeWindowMode) {
      if (data.w_mode === 'auto') {
        badgeWindowMode.textContent = '자동';
        badgeWindowMode.classList.remove('manual');
      } else {
        badgeWindowMode.textContent = '수동';
        badgeWindowMode.classList.add('manual');
      }
    }
  }

  if (data.angle !== null && data.angle !== undefined) {
    if (Date.now() - lastWindowSliderTime > 3000) {
      const windowSlider = document.getElementById('window-slider');
      if (windowSlider) windowSlider.value = data.angle;
      
      const txtSliderVal = document.getElementById('txt-slider-val');
      if (txtSliderVal) txtSliderVal.textContent = data.angle;
      
      // Highlight active preset card
      document.querySelectorAll('.preset-card').forEach(btn => {
        const btnAngle = getAngleFromCmd(btn.getAttribute('data-cmd'));
        if (btnAngle === data.angle) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

      // Update virtual window opening animation
      const winPct = Math.round(((data.angle - 90) / 90) * 100);
      const txtWindowPct = document.getElementById('txt-window-pct');
      if (txtWindowPct) txtWindowPct.textContent = `${winPct}%`;
      
      const windowGlass = document.getElementById('window-glass');
      if (windowGlass) {
        // Translate it up by winPct * 0.5 (frame is 110px, glass is 55px)
        windowGlass.style.transform = `translateY(-${winPct * 0.55}px)`;
      }
    }
  }

  // 7. Light Mode & Brightness representation
  if (data.l_mode) {
    const badgeLightMode = document.getElementById('badge-light-mode');
    if (badgeLightMode) {
      badgeLightMode.className = 'slider-percentage-badge badge-yellow';
      if (data.l_mode === 'auto') {
        badgeLightMode.textContent = '자동';
        badgeLightMode.style.backgroundColor = 'rgba(249, 168, 37, 0.08)';
        badgeLightMode.style.color = 'var(--light-accent)';
      } else {
        badgeLightMode.textContent = '수동';
        badgeLightMode.style.backgroundColor = '#e2e8f0';
        badgeLightMode.style.color = '#64748b';
      }
    }
  }

  if (data.led_color) {
    const isLedOn = data.led_color !== 'OFF';
    const rgbBulb = document.getElementById('rgb-bulb');
    if (rgbBulb) {
      rgbBulb.className = `rgb-bulb ${data.led_color.toLowerCase()}`;
    }
    
    // Toggle active state of power override buttons
    document.querySelectorAll('[data-cmd="7"]').forEach(btn => {
      if (isLedOn) btn.classList.add('active');
      else btn.classList.remove('active');
    });
    document.querySelectorAll('[data-cmd="8"]').forEach(btn => {
      if (!isLedOn) btn.classList.add('active');
      else btn.classList.remove('active');
    });
  }

  if (data.led_brightness !== undefined && data.led_brightness !== null) {
    updateLightUI(data.led_brightness, true);
  }

  // 8. Sound Mute State & Volume Telemetry Sync
  if (data.sound) {
    const isMuted = data.sound === 'OFF';
    const badgeSoundState = document.getElementById('badge-sound-state');
    if (badgeSoundState) {
      badgeSoundState.className = 'badge';
      if (!isMuted) {
        badgeSoundState.textContent = '켜짐';
        badgeSoundState.classList.add('bg-green');
      } else {
        badgeSoundState.textContent = '음소거 (MUTE)';
        badgeSoundState.classList.add('bg-red');
      }
    }

    const badgeSoundMode = document.getElementById('badge-sound-mode');
    if (badgeSoundMode) {
      badgeSoundMode.className = 'slider-percentage-badge';
      if (!isMuted) {
        badgeSoundMode.textContent = '소리 켜짐';
        badgeSoundMode.style.backgroundColor = 'rgba(13, 148, 136, 0.08)';
        badgeSoundMode.style.color = '#0D9488';
      } else {
        badgeSoundMode.textContent = '무음 상태';
        badgeSoundMode.style.backgroundColor = 'rgba(239, 68, 68, 0.08)';
        badgeSoundMode.style.color = '#EF4444';
      }
    }

    // Toggle active state of sound override buttons (ON/OFF)
    document.querySelectorAll('[data-cmd="20"]').forEach(btn => {
      if (!isMuted) btn.classList.add('active');
      else btn.classList.remove('active');
    });
    document.querySelectorAll('[data-cmd="21"]').forEach(btn => {
      if (isMuted) btn.classList.add('active');
      else btn.classList.remove('active');
    });
    
    // Sync home dashboard grid button state
    const txtSoundMain = document.getElementById('txt-sound-main');
    const soundIconMain = document.getElementById('sound-icon-main');
    if (txtSoundMain) txtSoundMain.textContent = !isMuted ? '음향 제어' : '음향 제어 (무음)';
    if (soundIconMain) soundIconMain.textContent = !isMuted ? 'volume_up' : 'volume_off';
  }

  // Volume Telemetry Sync
  if (data.volume !== undefined && data.volume !== null) {
    updateVolumeUI(data.volume, true);
  }

  // 9. Sync Mode Switch Highlights on Dashboard
  if (data.w_mode && data.l_mode) {
    if (Date.now() - lastModeSwitchTime > 3000) {
      const btnModeAutoMain = document.getElementById('btn-mode-auto-main');
      const btnModeManualMain = document.getElementById('btn-mode-manual-main');
      if (data.w_mode === 'auto' && data.l_mode === 'auto') {
        if (btnModeAutoMain) btnModeAutoMain.classList.add('active');
        if (btnModeManualMain) btnModeManualMain.classList.remove('active');
      } else {
        if (btnModeAutoMain) btnModeAutoMain.classList.remove('active');
        if (btnModeManualMain) btnModeManualMain.classList.add('active');
      }
    }
  }
}

// Helpers for state transformations
function getKoreanStateHeader(state) {
  switch (state) {
    case 'WAITING': return '대기 모드';
    case 'NORMAL': return '쾌적 실내';
    case 'VENTILATION': return '노을 바람 (자동환기)';
    case 'RAIN': return '우천 방어 (긴급닫힘)';
    case 'WARNING': return '고온 경고 (비상환기)';
    default: return state;
  }
}

function getKoreanStateLabel(state) {
  switch (state) {
    case 'WAITING': return '대기 상태 (WAITING) - 사람이 없음';
    case 'NORMAL': return '적정 상태 (NORMAL) - 날씨가 맑고 쾌적함';
    case 'VENTILATION': return '환기 상태 (VENTILATION) - 실내 온도 상승';
    case 'RAIN': return '우천 상태 (RAIN) - 외출 시 우산을 챙기세요!';
    case 'WARNING': return '고온 경고 (WARNING) - 실내 온도 과부하 개방';
    default: return state;
  }
}

function getOledIcon(state) {
  switch (state) {
    case 'WAITING': return '💤';
    case 'NORMAL': return '☀️';
    case 'VENTILATION': return '☁️';
    case 'RAIN': return '🌧️';
    case 'WARNING': return '🚨';
    default: return '❓';
  }
}

function updateVirtualNeopixels(state) {
  const leds = document.querySelectorAll('.neopixel-led');
  let color = '#374151'; // default dark gray (off)
  let shadow = 'none';

  switch (state) {
    case 'NORMAL':
      color = '#00796B'; // Teal
      shadow = '0 0 8px rgba(0, 121, 107, 0.8)';
      break;
    case 'VENTILATION':
      color = '#F9A825'; // Amber
      shadow = '0 0 8px rgba(249, 168, 37, 0.8)';
      break;
    case 'RAIN':
      color = '#2563eb'; // Blue
      shadow = '0 0 8px rgba(37, 99, 235, 0.8)';
      break;
    case 'WARNING':
      color = '#b91c1c'; // Red
      shadow = '0 0 8px rgba(185, 28, 28, 0.8)';
      break;
    case 'WAITING':
    default:
      color = '#475569'; // Off
      shadow = 'none';
      break;
  }

  leds.forEach(led => {
    led.style.backgroundColor = color;
    led.style.boxShadow = shadow;
  });
}

function getAngleFromCmd(cmd) {
  switch (cmd) {
    case '12': return 90;
    case '14': return 112;
    case '11': return 135;
    case '15': return 157;
    case '10': return 180;
    default: return null;
  }
}

// --- 📡 Web Bluetooth API Communication Section ---

// Handle Connect Bluetooth click
if (btnConnect) {
  btnConnect.addEventListener('click', async () => {
    if (isSimulating) {
      logTerminal('시뮬레이션 모드가 켜져 있습니다. 먼저 시뮬레이션을 끄십시오.', 'error');
      return;
    }

    if (bluetoothDevice && bluetoothDevice.gatt.connected) {
      logTerminal('블루투스 장치를 수동으로 연결 해제하는 중...', 'system');
      bluetoothDevice.gatt.disconnect();
      return;
    }

    try {
      logTerminal('블루투스 장치 검색 중 (필터: ESP_HEE)...', 'system');
      bluetoothDevice = await navigator.bluetooth.requestDevice({
        filters: [{ name: 'ESP_HEE' }],
        optionalServices: [NUS_SERVICE_UUID]
      });

      logTerminal(`장치 발견: ${bluetoothDevice.name}. GATT 연결 시도...`, 'system');
      bluetoothDevice.addEventListener('gattserverdisconnected', onDisconnected);
      
      const server = await bluetoothDevice.gatt.connect();
      
      logTerminal('GATT 연결 완료. NUS 서비스 정보 가져오는 중...', 'system');
      const service = await server.getPrimaryService(NUS_SERVICE_UUID);
      
      logTerminal('NUS 서비스 취득. 특성(Characteristics) 조회 중...', 'system');
      rxCharacteristic = await service.getCharacteristic(NUS_RX_UUID);
      txCharacteristic = await service.getCharacteristic(NUS_TX_UUID);
      
      logTerminal('알림 수신 시작 (Notify Enable)...', 'system');
      await txCharacteristic.startNotifications();
      txCharacteristic.addEventListener('characteristicvaluechanged', handleNotifications);
      
      // Update UI status
      if (connStatus) {
        connStatus.className = 'status-badge connected';
        const txt = connStatus.querySelector('.badge-text');
        if (txt) txt.textContent = bluetoothDevice.name;
      }
      if (btnConnect) {
        const iconSpan = btnConnect.querySelector('.btn-icon');
        const txtSpan = btnConnect.querySelector('.btn-text');
        if (iconSpan) iconSpan.textContent = 'bluetooth_disabled';
        if (txtSpan) txtSpan.textContent = '연결 해제';
        btnConnect.classList.add('connected-btn');
      }
      
      logTerminal('스마트홈 블루투스 연결 성공! 실시간 모니터링을 시작합니다.', 'info');
    } catch (err) {
      logTerminal(`블루투스 연결 에러: ${err.message}`, 'error');
      console.error(err);
    }
  });
}

// GATT server disconnected callback
function onDisconnected() {
  if (connStatus) {
    connStatus.className = 'status-badge disconnected';
    const txt = connStatus.querySelector('.badge-text');
    if (txt) txt.textContent = '연결 안 됨';
  }
  if (btnConnect) {
    const iconSpan = btnConnect.querySelector('.btn-icon');
    const txtSpan = btnConnect.querySelector('.btn-text');
    if (iconSpan) iconSpan.textContent = 'bluetooth';
    if (txtSpan) txtSpan.textContent = '블루투스 연결';
    btnConnect.classList.remove('connected-btn');
  }
  bluetoothDevice = null;
  rxCharacteristic = null;
  txCharacteristic = null;
  rxBuffer = '';
  logTerminal('블루투스 연결이 해제되었습니다.', 'system');
}

// Send command to ESP32 RX characteristic
async function sendCommand(cmdString) {
  if (isSimulating) {
    processSimulatedCommand(cmdString);
    return;
  }

  if (!rxCharacteristic) {
    logTerminal('명령 전송 실패: 블루투스가 연결되어 있지 않습니다.', 'error');
    return;
  }

  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(cmdString);
    await rxCharacteristic.writeValue(data);
    logTerminal(cmdString, 'tx');
  } catch (err) {
    logTerminal(`명령 전송 실패: ${err.message}`, 'error');
  }
}

// Receive ESP32 telemetry notifications
function handleNotifications(event) {
  const value = event.target.value;
  const decoder = new TextDecoder('utf-8');
  const text = decoder.decode(value);
  handleIncomingData(text);
}

// Brace-matching JSON parser to handle packet segmentation over BLE
function handleIncomingData(text) {
  rxBuffer += text;
  
  while (true) {
    const start = rxBuffer.indexOf('{');
    if (start === -1) {
      if (rxBuffer.length > 1000) rxBuffer = '';
      break;
    }
    
    let depth = 0;
    let end = -1;
    for (let i = start; i < rxBuffer.length; i++) {
      if (rxBuffer[i] === '{') depth++;
      else if (rxBuffer[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    
    if (end !== -1) {
      const jsonString = rxBuffer.slice(start, end + 1);
      rxBuffer = rxBuffer.slice(end + 1); // shrink buffer
      try {
        const telemetry = JSON.parse(jsonString);
        logTerminal(jsonString, 'rx');
        updateUI(telemetry);
      } catch (err) {
        console.warn('JSON 파싱 오류:', err, '원문:', jsonString);
      }
    } else {
      break;
    }
  }
}

// --- 🛠️ Dashboard Interactive Events ---

// 1. Angle Shortcut Buttons Clicked
document.querySelectorAll('.btn-control').forEach(btn => {
  btn.addEventListener('click', () => {
    lastWindowSliderTime = Date.now();
    const cmd = btn.getAttribute('data-cmd');
    sendCommand(cmd);
  });
});

// 스마트 창문 닫기 카드 직접 작동 (90도로 즉시 닫힘)
const btnWindowCloseCard = document.getElementById('btn-window-close-card');
if (btnWindowCloseCard) {
  btnWindowCloseCard.addEventListener('click', () => {
    lastWindowSliderTime = Date.now();
    sendCommand('12');
  });
}

// 2. Window Angle Slider sliding (Live Preview)
const windowSlider = document.getElementById('window-slider');
if (windowSlider) {
  windowSlider.addEventListener('input', (e) => {
    lastWindowSliderTime = Date.now();
    const val = e.target.value;
    const txtSliderVal = document.getElementById('txt-slider-val');
    if (txtSliderVal) txtSliderVal.textContent = val;
    const winPct = Math.round(((val - 90) / 90) * 100);
    const txtWindowPct = document.getElementById('txt-window-pct');
    if (txtWindowPct) txtWindowPct.textContent = `${winPct}%`;
    const windowGlass = document.getElementById('window-glass');
    if (windowGlass) {
      windowGlass.style.transform = `translateY(-${winPct * 0.55}px)`;
    }
    sendCommandThrottled(`W:${val}`);
  });

  // 3. Window Angle Slider released (Send command "W:[angle]")
  windowSlider.addEventListener('change', (e) => {
    lastWindowSliderTime = Date.now();
    const angle = e.target.value;
    sendCommand(`W:${angle}`);
  });
}

// 4. Action buttons (Lights, Sound, System Mode)
document.querySelectorAll('[data-cmd]').forEach(btn => {
  if (!btn.classList.contains('btn-control')) {
    btn.addEventListener('click', () => {
      const cmd = btn.getAttribute('data-cmd');
      sendCommand(cmd);
    });
  }
});



// 6. Home Auto/Manual Mode click triggers
const btnModeAutoMain = document.getElementById('btn-mode-auto-main');
const btnModeManualMain = document.getElementById('btn-mode-manual-main');
if (btnModeAutoMain) {
  btnModeAutoMain.addEventListener('click', () => {
    lastModeSwitchTime = Date.now();
    btnModeAutoMain.classList.add('active');
    if (btnModeManualMain) btnModeManualMain.classList.remove('active');
    sendCommand('0'); // Send AUTO
  });
}
if (btnModeManualMain) {
  btnModeManualMain.addEventListener('click', () => {
    lastModeSwitchTime = Date.now();
    btnModeManualMain.classList.add('active');
    if (btnModeAutoMain) btnModeAutoMain.classList.remove('active');
    sendCommand('1'); // Send MANUAL
    
    // "수동일 때는 자동으로 창문 열리고 거실 불빛도 내가 원하는 밝기로 조절 가능하도록"
    // Send window 100% open (10) and turn light ON (7)
    setTimeout(() => {
      sendCommand('10');
    }, 150);
    setTimeout(() => {
      sendCommand('7');
    }, 300);
  });
}

// 7. Light Screen Brightness Slider & Preset chips
const lightBrightnessSlider = document.getElementById('light-brightness-slider');
if (lightBrightnessSlider) {
  lightBrightnessSlider.addEventListener('input', (e) => {
    lastLightSliderTime = Date.now();
    const val = parseInt(e.target.value);
    updateLightUI(val);
    sendCommandThrottled(`L:${val}`);
  });
  
  lightBrightnessSlider.addEventListener('change', (e) => {
    lastLightSliderTime = Date.now();
    const val = parseInt(e.target.value);
    sendCommand(`L:${val}`);
  });
}

document.querySelectorAll('[data-light-preset]').forEach(btn => {
  btn.addEventListener('click', () => {
    lastLightSliderTime = Date.now();
    const val = parseInt(btn.getAttribute('data-light-preset'));
    updateLightUI(val);
    sendCommand(`L:${val}`);
  });
});

// 8. Volume control slider
const volSlider = document.getElementById('vol-slider');
if (volSlider) {
  volSlider.addEventListener('input', (e) => {
    lastVolumeSliderTime = Date.now();
    const val = parseInt(e.target.value);
    const volValText = document.getElementById('vol-val-text');
    if (volValText) volValText.textContent = `${val}%`;
    const txtVolVal = document.getElementById('txt-volume-val');
    if (txtVolVal) txtVolVal.textContent = `${val}%`;
    
    // update the ring fill locally for responsive feeling
    const ringFill = document.getElementById('volume-ring-fill');
    const strokeDash = (val / 100) * 276.4;
    if (ringFill) {
      ringFill.setAttribute('stroke-dasharray', `${strokeDash}, 276.4`);
    }

    // Bidirectional sync with mute state
    const badgeSoundMode = document.getElementById('badge-sound-mode');
    const isCurrentlyMuted = badgeSoundMode && badgeSoundMode.textContent === '무음 상태';
    if (val > 0 && isCurrentlyMuted) {
      sendCommand('20'); // Unmute
      if (badgeSoundMode) {
        badgeSoundMode.textContent = '소리 켜짐';
        badgeSoundMode.style.backgroundColor = 'rgba(13, 148, 136, 0.08)';
        badgeSoundMode.style.color = '#0D9488';
      }
      document.querySelectorAll('[data-cmd="20"]').forEach(btn => btn.classList.add('active'));
      document.querySelectorAll('[data-cmd="21"]').forEach(btn => btn.classList.remove('active'));
    } else if (val === 0 && !isCurrentlyMuted) {
      sendCommand('21'); // Mute
      if (badgeSoundMode) {
        badgeSoundMode.textContent = '무음 상태';
        badgeSoundMode.style.backgroundColor = 'rgba(239, 68, 68, 0.08)';
        badgeSoundMode.style.color = '#EF4444';
      }
      document.querySelectorAll('[data-cmd="20"]').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('[data-cmd="21"]').forEach(btn => btn.classList.add('active'));
    }

    sendCommandThrottled(`V:${val}`);
  });
  
  volSlider.addEventListener('change', (e) => {
    lastVolumeSliderTime = Date.now();
    const val = parseInt(e.target.value);
    sendCommand(`V:${val}`);

    // Bidirectional sync safety check on release
    const badgeSoundMode = document.getElementById('badge-sound-mode');
    const isCurrentlyMuted = badgeSoundMode && badgeSoundMode.textContent === '무음 상태';
    if (val > 0 && isCurrentlyMuted) {
      sendCommand('20');
    } else if (val === 0 && !isCurrentlyMuted) {
      sendCommand('21');
    }
  });
}

// --- 🔮 Local Simulation Engine ---

if (simToggle) {
  simToggle.addEventListener('change', (e) => {
    isSimulating = e.target.checked;
    if (isSimulating) {
      if (bluetoothDevice && bluetoothDevice.gatt.connected) {
        logTerminal('시뮬레이션을 켜기 위해 블루투스 연결을 먼저 종료합니다.', 'system');
        bluetoothDevice.gatt.disconnect();
      }
      
      if (connStatus) {
        connStatus.className = 'status-badge connected';
        const txt = connStatus.querySelector('.badge-text');
        if (txt) txt.textContent = '시뮬레이터';
      }
      logTerminal('시뮬레이션 모드가 활성화되었습니다.', 'info');
      startSimulation();
    } else {
      if (connStatus) {
        connStatus.className = 'status-badge disconnected';
        const txt = connStatus.querySelector('.badge-text');
        if (txt) txt.textContent = '연결 안 됨';
      }
      logTerminal('시뮬레이션 모드가 종료되었습니다.', 'system');
      stopSimulation();
    }
  });
}

function startSimulation() {
  simMotionTimer = Date.now();
  simRainTimer = Date.now();
  runSimulationCycle();
  simInterval = setInterval(runSimulationCycle, 2000);
}

function stopSimulation() {
  if (simInterval) {
    clearInterval(simInterval);
    simInterval = null;
  }
  
  // Reset all elements defensively
  const txtTemp = document.getElementById('txt-temp');
  if (txtTemp) txtTemp.textContent = '--';
  const txtWinTemp = document.getElementById('txt-window-temp');
  if (txtWinTemp) txtWinTemp.textContent = '--°C';
  const txtWinHumi = document.getElementById('txt-window-humi');
  if (txtWinHumi) txtWinHumi.textContent = '습도 --%';
  const txtCds = document.getElementById('txt-cds');
  if (txtCds) txtCds.textContent = '--';
  
  const badgeAirMain = document.getElementById('badge-air-main');
  if (badgeAirMain) {
    badgeAirMain.textContent = '대기 중';
    badgeAirMain.className = 'badge bg-gray';
  }
  const badgeAir = document.getElementById('badge-air');
  if (badgeAir) {
    badgeAir.className = 'air-card-desc badge bg-gray';
    badgeAir.textContent = '대기 중';
  }
  const badgePir = document.getElementById('badge-pir');
  if (badgePir) {
    badgePir.className = 'badge bg-gray';
    badgePir.textContent = '대기 중';
  }
  const badgeRain = document.getElementById('badge-rain');
  if (badgeRain) {
    badgeRain.className = 'badge bg-gray';
    badgeRain.textContent = '대기 중';
  }
  
  const oledIcon = document.getElementById('oled-icon');
  if (oledIcon) oledIcon.textContent = '💤';
  const oledText = document.getElementById('oled-status-text');
  if (oledText) oledText.textContent = 'WAITING';
  const txtSystemState = document.getElementById('txt-system-state');
  if (txtSystemState) txtSystemState.textContent = '대기 상태 (WAITING)';
  
  const systemStateBadge = document.getElementById('system-state-badge');
  if (systemStateBadge) systemStateBadge.className = 'status-big-badge';
  
  const badgeWindowMode = document.getElementById('badge-window-mode');
  if (badgeWindowMode) {
    badgeWindowMode.className = 'badge-active-pill';
    badgeWindowMode.textContent = '대기 중';
    badgeWindowMode.style.backgroundColor = '#64748b';
  }
  const badgeLightMode = document.getElementById('badge-light-mode');
  if (badgeLightMode) {
    badgeLightMode.textContent = '대기 중';
    badgeLightMode.style.backgroundColor = '#e2e8f0';
    badgeLightMode.style.color = '#64748b';
  }
  const txtWindowModeDesc = document.getElementById('txt-window-mode-desc');
  if (txtWindowModeDesc) txtWindowModeDesc.textContent = '대기 모드';
  
  updateVirtualNeopixels('WAITING');
  updateLightUI(0);
}

function runSimulationCycle() {
  const now = Date.now();
  
  // 1. Simulate environmental changes
  simData.temp = Math.round(29 + 9 * Math.sin(now / 15000));
  simData.humi = Math.round(55 + 25 * Math.cos(now / 20000));
  simData.cds = Math.round(1300 + 800 * Math.sin(now / 8000));

  const motionCycle = Math.floor(now / 15000) % 2;
  simData.pir_raw = motionCycle === 0 ? 1 : 0;
  if (simData.pir_raw === 1) simMotionTimer = now;
  simData.occupied = (now - simMotionTimer < 15000) ? 1 : 0;

  const rainCycle = Math.floor(now / 30000) % 2;
  simData.rain_raw = rainCycle === 0 ? 0 : 1;
  if (simData.rain_raw === 0) simRainTimer = now;
  simData.rain_det = (now - simRainTimer < 15000) ? 1 : 0;

  // 2. Evaluate simulated ESP32 complex auto logic (if auto mode)
  if (simData.w_mode === 'auto') {
    if (!simData.occupied) {
      simData.angle = 90;
      simData.state = 'WAITING';
    } else if (simData.rain_det === 1) {
      simData.angle = 90;
      simData.state = 'RAIN';
    } else if (simData.temp >= 35) {
      simData.angle = 180;
      simData.state = 'WARNING';
    } else if (simData.temp <= 23) {
      simData.angle = 90;
      simData.state = 'NORMAL';
    } else {
      simData.angle = 135;
      simData.state = 'VENTILATION';
    }
  }

  // Auto lighting based on CdS
  if (simData.l_mode === 'auto') {
    if (simData.cds > 1500) {
      simData.led_color = 'WHITE';
      simData.led_brightness = 100;
    } else {
      simData.led_color = 'OFF';
      simData.led_brightness = 0;
    }
  }

  const jsonPayload = JSON.stringify(simData);
  handleIncomingData(jsonPayload);
}

function processSimulatedCommand(cmd) {
  logTerminal(cmd, 'tx');
  
  if (cmd === '0') {
    simData.w_mode = 'auto';
    simData.l_mode = 'auto';
    logTerminal('시뮬레이터 → 전체 자동 모드로 전환 완료', 'system');
  } else if (cmd === '1') {
    simData.w_mode = 'manual';
    simData.l_mode = 'manual';
    logTerminal('시뮬레이터 → 전체 수동 모드로 전환 완료', 'system');
  } else if (cmd === '7') {
    simData.l_mode = 'manual';
    simData.led_color = 'WHITE';
    simData.led_brightness = 100;
    logTerminal('시뮬레이터 → 조명 수동 ON (100% White)', 'system');
  } else if (cmd === '8') {
    simData.l_mode = 'manual';
    simData.led_color = 'OFF';
    simData.led_brightness = 0;
    logTerminal('시뮬레이터 → 조명 수동 OFF (0% Off)', 'system');
  } else if (cmd.startsWith('L:')) {
    const brightness = parseInt(cmd.split(':')[1]);
    simData.l_mode = 'manual';
    simData.led_brightness = brightness;
    simData.led_color = brightness > 0 ? 'WHITE' : 'OFF';
    logTerminal(`시뮬레이터 → 조명 수동 밝기 조절: ${brightness}%`, 'system');
  } else if (cmd === '10') {
    simData.w_mode = 'manual';
    simData.angle = 180;
    logTerminal('시뮬레이터 → 창문 수동 100% 완전개방 (180°)', 'system');
  } else if (cmd === '11') {
    simData.w_mode = 'manual';
    simData.angle = 135;
    logTerminal('시뮬레이터 → 창문 수동 50% 반개방 (135°)', 'system');
  } else if (cmd === '12') {
    simData.w_mode = 'manual';
    simData.angle = 90;
    logTerminal('시뮬레이터 → 창문 수동 0% 닫기 (90°)', 'system');
  } else if (cmd === '13') {
    simData.w_mode = 'auto';
    logTerminal('시뮬레이터 → 창문 제어 자동 모드로 복귀 완료', 'system');
  } else if (cmd === '14') {
    simData.w_mode = 'manual';
    simData.angle = 112;
    logTerminal('시뮬레이터 → 창문 수동 25% 열기 (112°)', 'system');
  } else if (cmd === '15') {
    simData.w_mode = 'manual';
    simData.angle = 157;
    logTerminal('시뮬레이터 → 창문 수동 75% 열기 (157°)', 'system');
  } else if (cmd === '20') {
    simData.sound = 'ON';
    logTerminal('시뮬레이터 → 창문 멜로디 음향 활성화 (Sound ON)', 'system');
  } else if (cmd === '21') {
    simData.sound = 'OFF';
    logTerminal('시뮬레이터 → 창문 멜로디 음소거 (Sound OFF)', 'system');
  } else if (cmd.startsWith('V:')) {
    const val = parseInt(cmd.split(':')[1]);
    simData.volume = val;
    simData.sound = val > 0 ? 'ON' : 'OFF';
    logTerminal(`시뮬레이터 → 음량 설정: ${val}%`, 'system');
  } else if (cmd.startsWith('W:')) {
    const angle = parseInt(cmd.split(':')[1]);
    simData.w_mode = 'manual';
    simData.angle = angle;
    logTerminal(`시뮬레이터 → 창문 수동 슬라이더 조정: ${angle}°`, 'system');
  }
  
  const jsonPayload = JSON.stringify(simData);
  handleIncomingData(jsonPayload);
}

// On page load setup
window.addEventListener('DOMContentLoaded', () => {
  initNeopixelRing();
  updateVirtualNeopixels('WAITING');
  navigateToScreen('home'); // Go to home screen by default
  updateLightUI(0);
  updateVolumeUI(100); // Initialize volume UI to 100% on load

  // Bind bottom nav click events
  document.querySelectorAll('.bottom-nav .nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.getAttribute('data-tab');
      navigateToScreen(tab);
    });
  });

  // Bind any elements with data-nav attributes
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const target = el.getAttribute('data-nav');
      navigateToScreen(target);
    });
  });
});
