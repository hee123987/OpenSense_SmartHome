from machine import ADC, Pin, PWM, SoftI2C
from neopixel import NeoPixel
from servo import Servo
from time import sleep, ticks_ms, ticks_diff

import dht
import bluetooth
import ble_library

from lcd_api import LcdApi
from i2c_lcd import I2cLcd

import ssd1306
import framebuf
import json


# ==================================================
# 1. 핀 번호 설정
# ==================================================
SERVO_PIN = 13
DHT_PIN = 14

NEO_PIN = 32
PIR_PIN = 33
RAIN_PIN = 34
CDS_PIN = 36

RGB_R_PIN = 25
RGB_G_PIN = 26
RGB_B_PIN = 27

TOUCH1_PIN = 17
TOUCH2_PIN = 5
TOUCH3_PIN = 18
TOUCH4_PIN = 19

NUM_LEDS = 12


# ==================================================
# 2. 센서 및 장치 설정
# ==================================================
motor = Servo(pin=SERVO_PIN)
d = dht.DHT11(Pin(DHT_PIN))
pir = Pin(PIR_PIN, Pin.IN)
rain = Pin(RAIN_PIN, Pin.IN)
np = NeoPixel(Pin(NEO_PIN), NUM_LEDS)

cds = ADC(Pin(CDS_PIN))
cds.atten(ADC.ATTN_11DB)

# RGB LED PWM 초기화 (주파수 1000Hz, 초기 듀티 0)
ledR = PWM(Pin(RGB_R_PIN))
ledG = PWM(Pin(RGB_G_PIN))
ledB = PWM(Pin(RGB_B_PIN))
ledR.freq(1000)
ledG.freq(1000)
ledB.freq(1000)
ledR.duty(0)
ledG.duty(0)
ledB.duty(0)

touch1 = Pin(TOUCH1_PIN, Pin.IN)
touch2 = Pin(TOUCH2_PIN, Pin.IN)
touch3 = Pin(TOUCH3_PIN, Pin.IN)
touch4 = Pin(TOUCH4_PIN, Pin.IN)

piezo = PWM(Pin(23))
piezo.freq(1000)
piezo.duty(0)


# ==================================================
# 3. 멜로디 설정
# ==================================================
melody1 = (659, 784, 1047, 1318)  # 창문 열림 멜로디
melody2 = (784, 659, 523, 392)    # 비 감지 / 창문 닫힘 멜로디


# ==================================================
# 4. LCD 설정 및 커스텀 아이콘 등록 (🌡️, 💧)
# ==================================================
i2c = SoftI2C(sda=Pin(21), scl=Pin(22))

lcd = None
try:
    lcd = I2cLcd(i2c, 0x27, 2, 16)
    lcd.clear()
    lcd.backlight_on()
    print("[시스템] LCD (0x27) 연결 성공")
except Exception:
    try:
        lcd = I2cLcd(i2c, 0x3F, 2, 16)
        lcd.clear()
        lcd.backlight_on()
        print("[시스템] LCD (0x3F) 연결 성공")
    except Exception as e:
        print("[경고] LCD 연결 실패:", e)

if lcd:
    try:
        temp_icon = bytearray([0x04, 0x0A, 0x0A, 0x0A, 0x11, 0x1F, 0x1F, 0x0E]) # 🌡️ 온도계
        humi_icon = bytearray([0x04, 0x0E, 0x0E, 0x1F, 0x1F, 0x1F, 0x0E, 0x00]) # 💧 물방울

        lcd.custom_char(0, temp_icon)  # chr(0) -> 🌡️
        lcd.custom_char(1, humi_icon)  # chr(1) -> 💧
    except Exception as e:
        print("[LCD 아이콘 등록 실패]:", e)


# ==================================================
# 5. OLED 설정 및 PBM 이미지 출력 함수
# ==================================================
display2 = None
try:
    display2 = ssd1306.SSD1306_I2C(128, 64, i2c)
    display2.fill(0)
    display2.show()
    print("[시스템] OLED 연결 성공")
except Exception as e:
    print("[경고] OLED 연결 실패:", e)

def show_pbm_image(filename):
    if display2 is None:
        return
    try:
        filepath = 'img/' + filename
        with open(filepath, 'rb') as f:
            f.readline()  # 1번째 줄: 포맷 (P4)
            f.readline()  # 2번째 줄: 해상도 (128 64)
            data = bytearray(f.read())
            
        fb = framebuf.FrameBuffer(data, 128, 64, framebuf.MONO_HLSB)
        display2.fill(0)
        display2.blit(fb, 0, 0)
        display2.show()
        print(f"[OLED] {filename} 이미지 출력 성공!")
    except Exception as error:
        print(f"[OLED 오류] {filename} 출력 실패:", error)


# ==================================================
# 6. BLE 설정
# ==================================================
ble = bluetooth.BLE()
p = ble_library.BLESimplePeripheral(ble, "ESP_HEE")


# ==================================================
# 7. 상태 및 기준값 설정
# ==================================================
WINDOW_CLOSED = 90
WINDOW_HALF = 135
WINDOW_OPEN = 180

NORMAL_TEMP_MAX = 23
HALF_OPEN_TEMP_MAX = 35
WARNING_TEMP = 35

OCCUPANCY_TIMEOUT = 15000
RAIN_TIMEOUT = 15000

DHT_INTERVAL = 2000      # 센서 측정 간격 (2초)
LCD_INTERVAL = 7000      # LCD 화면 전환 간격 (7초)

# 조도센서 어두움 기준값 (가려서 올라가는 값 감지)
DARK_THRESHOLD = 1500

temperature = None
humidity = None

last_motion_time = None
last_rain_time = None
last_dht_time = 0
last_lcd_time = 0
last_ble_time = 0
BLE_INTERVAL = 2000

current_window_angle = None
current_state = None

# RGB 조명 모드, 창문 제어 모드 및 멜로디 음소거 설정
light_mode = "auto"
window_mode = "auto"
sound_enabled = True     # 💡 멜로디 On/Off 상태 변수 (기본 켜짐)
lcd_page = 0


# ==================================================
# 8. 네오픽셀 / RGB / 창문 제어 함수
# ==================================================
def set_neopixel(r, g, b):
    for i in range(NUM_LEDS): np[i] = (r, g, b)
    np.write()

def neopixel_off(): set_neopixel(0, 0, 0)
def neopixel_normal(): set_neopixel(0, 255, 0)
def neopixel_ventilation(): set_neopixel(255, 255, 0)
def neopixel_rain(): set_neopixel(0, 0, 255)
def neopixel_warning(): set_neopixel(255, 0, 0)

# 현재 조명 밝기 및 색상 상태 변수
current_light_brightness = 0

def rgb_off():
    global current_light_brightness
    ledR.duty(0); ledG.duty(0); ledB.duty(0)
    current_light_brightness = 0

def rgb_white():
    global current_light_brightness
    ledR.duty(1023); ledG.duty(1023); ledB.duty(1023)
    current_light_brightness = 100

def rgb_red():
    global current_light_brightness
    ledR.duty(1023); ledG.duty(0); ledB.duty(0)
    current_light_brightness = 100

def rgb_green():
    global current_light_brightness
    ledR.duty(0); ledG.duty(1023); ledB.duty(0)
    current_light_brightness = 100

def rgb_blue():
    global current_light_brightness
    ledR.duty(0); ledG.duty(0); ledB.duty(1023)
    current_light_brightness = 100

def rgb_brightness(pct):
    global current_light_brightness
    val = int(pct / 100 * 1023)
    ledR.duty(val); ledG.duty(val); ledB.duty(val)
    current_light_brightness = pct

# 피에조 부저 기본 볼륨 설정 (0~100)
sound_volume = 100
last_volume_beep_time = 0

def play_melody(melody):
    global sound_enabled, sound_volume
    # 💡 멜로디 활성화 상태이고 볼륨이 0보다 클 때만 소리 출력!
    if not sound_enabled or sound_volume == 0:
        return
    # 볼륨 비례하여 10비트 duty 설정 (최대 볼륨은 50% 듀티인 512 수준)
    duty = int(sound_volume / 100 * 512)
    piezo.duty(duty)
    for note in melody:
        piezo.freq(note)
        sleep(0.3)
    piezo.duty(0)
    piezo.freq(1)



# 창문 제어 및 동작 멜로디 재생 함수
def set_window(angle, is_rain=False):
    global current_window_angle
    if current_window_angle != angle:
        old_angle = current_window_angle
        motor.move(angle)
        current_window_angle = angle
        print("서보모터 각도:", angle)

        # 1) 창문이 완전히 닫힐 때 (각도 90도) ➡️ 닫힘 멜로디 재생
        if angle == WINDOW_CLOSED:
            print("[알림] 창문 닫힘 멜로디 재생")
            play_melody(melody2)
        # 2) 창문이 열릴 때 (기존 90도 닫힘 상태에서 임의의 각도로 열릴 때) ➡️ 열림 멜로디 재생
        elif (old_angle == WINDOW_CLOSED or old_angle is None) and angle > WINDOW_CLOSED:
            print("[알림] 창문 열림 멜로디 재생")
            play_melody(melody1)

def set_system_state(state, message):
    global current_state
    if current_state == state: return
    current_state = state

    print("\n================================")
    print(message)
    print("현재 상태:", state)
    print("================================")

    if state == "WAITING":
        neopixel_off()
        if display2: display2.fill(0); display2.show()
    elif state == "NORMAL":
        neopixel_normal()
        show_pbm_image("sunny.pbm")
    elif state == "VENTILATION":
        neopixel_ventilation()
        show_pbm_image("cloudy.pbm")
    elif state == "RAIN":
        neopixel_rain()
        show_pbm_image("rainy.pbm")
    elif state == "WARNING":
        neopixel_warning()

def send_telemetry():
    try:
        try: rain_det_val = 1 if rain_detected else 0
        except NameError: rain_det_val = 0
        
        try: occ_val = 1 if occupied else 0
        except NameError: occ_val = 0

        # PWM 객체의 duty 값을 읽어 색상 판별
        r_duty = ledR.duty()
        g_duty = ledG.duty()
        b_duty = ledB.duty()
        if r_duty > 0 and g_duty > 0 and b_duty > 0:
            rgb_color = "WHITE"
        elif r_duty > 0 and g_duty == 0 and b_duty == 0:
            rgb_color = "RED"
        elif r_duty == 0 and g_duty > 0 and b_duty == 0:
            rgb_color = "GREEN"
        elif r_duty == 0 and g_duty == 0 and b_duty > 0:
            rgb_color = "BLUE"
        else:
            rgb_color = "OFF"

        data = {
            "temp": temperature,
            "humi": humidity,
            "cds": cds.read(),
            "rain_raw": rain.value(),
            "rain_det": rain_det_val,
            "pir_raw": pir.value(),
            "occupied": occ_val,
            "state": current_state,
            "w_mode": window_mode,
            "l_mode": light_mode,
            "sound": "ON" if sound_enabled else "OFF",
            "angle": current_window_angle,
            "led_color": rgb_color,
            "led_brightness": current_light_brightness,
            "volume": sound_volume
        }
        payload = json.dumps(data) + "\n"
        
        # BLE MTU 20바이트 한계를 넘지 않도록 패킷을 분할 전송
        chunk_size = 20
        for i in range(0, len(payload), chunk_size):
            chunk = payload[i:i+chunk_size]
            try:
                p.send(chunk)
            except TypeError:
                try:
                    p.send(chunk.encode('utf-8'))
                except Exception as e:
                    print("[BLE 송신오류-바이트]:", e)
            except Exception as e:
                print("[BLE 송신오류-기본]:", e)
            sleep(0.015) # 15ms 대기하여 전송 오버플로우 방지
    except Exception as e:
        print("[BLE 데이터생성 오류]:", e)

def measure_dht():
    global temperature, humidity
    try:
        d.measure()
        temperature = int(d.temperature())
        humidity = int(d.humidity())
        return True
    except Exception as error:
        return False


# ==================================================
# 9. 실시간 스마트 LCD 디스플레이 업데이트 함수
# ==================================================
def update_lcd_display(rain_detected, occupied):
    if lcd is None:
        return
    try:
        global lcd_page
        lcd.clear()

        # [1순위] 비가 올 때 ➔ 우산 경고
        if rain_detected:
            lcd.move_to(0, 0)
            lcd.putstr(" RAIN DETECTED!")   # 첫 번째 줄: 경고 메시지
            lcd.move_to(0, 1)
            lcd.putstr(" Bring Umbrella")   # 두 번째 줄: 우산 챙기기 안내
            return

        # [2순위] 사람이 없을 때 (대기 상태)
        if not occupied:
            lcd.move_to(0, 0); lcd.putstr("OpenSense Home  ")
            lcd.move_to(0, 1); lcd.putstr("Status: WAITING ")
            return

        # [3순위] 사람이 집에 있을 때 ➔ 7초 간격 전환
        if lcd_page == 0:
            if temperature is not None and humidity is not None:
                # 1번째 줄: [🌡️] 24°C   [💧] 55%
                lcd.move_to(0, 0)
                lcd.putchar(chr(0))
                lcd.putstr(f" {temperature}\xdfC   ")
                lcd.putchar(chr(1))
                lcd.putstr(f" {humidity}%  ")

                # 2번째 줄: 습도 기반 쾌적도 상태 표시
                lcd.move_to(0, 1)
                if humidity > 65:
                    lcd.putstr("Air: HUMID      ")
                elif humidity < 40:
                    lcd.putstr("Air: DRY        ")
                else:
                    lcd.putstr("Air: GOOD       ")
            else:
                lcd.move_to(0, 0); lcd.putstr("Checking Air... ")
                lcd.move_to(0, 1); lcd.putstr("Please Wait...  ")

            lcd_page = 1

        else:
            # Page 1: 창문 및 조명의 동작 모드 상태 출력 (AUTO / MAN)
            win_str = "AUTO" if window_mode == "auto" else "MAN "
            light_str = "AUTO" if light_mode == "auto" else "MAN "

            lcd.move_to(0, 0); lcd.putstr("System: NORMAL  ")
            lcd.move_to(0, 1); lcd.putstr(f"W:{win_str} | L:{light_str} ")

            lcd_page = 0

    except Exception as e:
        print("[LCD 오류]:", e)


# ==================================================
# 10. BLE 명령 처리
# ==================================================
def on_rx(v):
    global light_mode, window_mode, sound_enabled
    try: command = v.decode().strip() if isinstance(v, bytes) else str(v).strip()
    except Exception: command = str(v)

    # --- 1) 모드 전체 제어 ---
    if command == "0":
        light_mode = "auto"
        window_mode = "auto"
        print("BLE → 전체 자동 모드 전환")
    elif command == "1":
        light_mode = "manual"
        window_mode = "manual"
        print("BLE → 전체 수동 모드 전환")

    # --- 2) 조명 수동 제어 ---
    elif command == "7":
        light_mode = "manual"
        rgb_white()
        print("BLE → 조명 수동 ON")
    elif command == "8":
        light_mode = "manual"
        rgb_off()
        print("BLE → 조명 수동 OFF")
    elif command.startswith("L:"):
        try:
            target_brightness = int(command.split(":")[1])
            target_brightness = max(0, min(100, target_brightness))
            light_mode = "manual"
            rgb_brightness(target_brightness)
            print(f"BLE → 조명 상세 밝기 제어 ({target_brightness}%)")
        except Exception as e:
            print("[BLE 조명 밝기 제어 오류]:", e)

    # --- 3) 창문 수동 제어 ---
    elif command == "10":
        window_mode = "manual"
        set_window(WINDOW_OPEN)  # 100% 열기 (180도)
        print("BLE → 창문 100% 열기")
    elif command == "11":
        window_mode = "manual"
        set_window(WINDOW_HALF)  # 50% 반개방 (135도)
        print("BLE → 창문 50% 반개방")
    elif command == "12":
        window_mode = "manual"
        set_window(WINDOW_CLOSED) # 0% 닫기 (90도)
        print("BLE → 창문 닫기")
    elif command == "13":
        window_mode = "auto"
        print("BLE → 창문 자동 모드 복귀")
    elif command == "14":
        window_mode = "manual"
        set_window(112)          # 25% 열기 (약 112도)
        print("BLE → 창문 25% 열기")
    elif command == "15":
        window_mode = "manual"
        set_window(157)          # 75% 열기 (약 157도)
        print("BLE → 창문 75% 열기")

    # --- 4) 💡 멜로디 음소거(On/Off) 설정 (앱 첫화면 '음향 제어' 연동) ---
    elif command == "20":
        sound_enabled = True
        print("BLE → 멜로디 켜기 (Sound ON)")
    elif command == "21":
        sound_enabled = False
        print("BLE → 멜로디 끄기/음소거 (Sound OFF)")
    elif command.startswith("V:"):
        try:
            target_volume = int(command.split(":")[1])
            target_volume = max(0, min(100, target_volume))
            sound_volume = target_volume
            print(f"BLE → 음량 상세 설정 ({target_volume}%)")
        except Exception as e:
            print("[BLE 음량 조절 오류]:", e)

    # --- 5) 창문 슬라이더 상세 제어 (예: "W:120") ---
    elif command.startswith("W:"):
        try:
            target_angle = int(command.split(":")[1])
            target_angle = max(90, min(180, target_angle))
            window_mode = "manual"
            set_window(target_angle)
            print(f"BLE → 창문 슬라이더 제어 ({target_angle}도)")
        except Exception as e:
            print("[BLE 창문 슬라이더 오류]:", e)
    
    # BLE 명령 실행 후 즉시 텔레메트리 업데이트 송신
    send_telemetry()

p.on_write(on_rx)


# ==================================================
# 11. 프로그램 초기화
# ==================================================
print("\n================================")
print("OpenSense 스마트홈 시작")
print("================================")

if lcd:
    try:
        lcd.clear()
        lcd.move_to(0, 0); lcd.putstr("OpenSense Home")
        lcd.move_to(0, 1); lcd.putstr("System Ready...")
    except Exception: pass

set_window(WINDOW_CLOSED)
neopixel_off()
rgb_off()
measure_dht()

last_dht_time = ticks_ms()
last_lcd_time = ticks_ms()
last_ble_time = ticks_ms()
prev_rain_detected = False


# ==================================================
# 12. 메인 반복문
# ==================================================
while True:
    now = ticks_ms()

    # --- PIR 센서 ---
    pir_value = pir.value()
    if pir_value == 1: last_motion_time = now
    occupied = False if last_motion_time is None else (ticks_diff(now, last_motion_time) < OCCUPANCY_TIMEOUT)

    # --- 빗물 센서 ---
    rain_value = rain.value()
    if rain_value == 0: last_rain_time = now
    rain_detected = False if last_rain_time is None else (ticks_diff(now, last_rain_time) < RAIN_TIMEOUT)

    # --- DHT11 온습도 측정 (2초 간격) ---
    if ticks_diff(now, last_dht_time) >= DHT_INTERVAL:
        measure_dht()
        last_dht_time = now

    # --- LCD 화면 갱신 (7초 간격, 우천 감지 상태 변화 시 즉시 갱신) ---
    if rain_detected != prev_rain_detected:
        prev_rain_detected = rain_detected
        update_lcd_display(rain_detected, occupied)
        last_lcd_time = now
    elif ticks_diff(now, last_lcd_time) >= LCD_INTERVAL:
        update_lcd_display(rain_detected, occupied)
        last_lcd_time = now

    # --- BLE 텔레메트리 송신 (2초 간격) ---
    if ticks_diff(now, last_ble_time) >= BLE_INTERVAL:
        send_telemetry()
        last_ble_time = now

    # --- 1) 실시간 환경 상태 평가 (자동/수동 불문 상시 동작) ---
    if temperature is None:
        temp_state = "WARNING"
        state_msg = "[경고 상태] 온도센서 측정 오류"
    elif rain_detected:
        temp_state = "RAIN"
        state_msg = "[우천 상태] 비 감지"
    elif not occupied:
        temp_state = "WAITING"
        state_msg = "[대기 상태] 사람 없음"
    elif temperature >= WARNING_TEMP:
        temp_state = "WARNING"
        state_msg = "[경고 상태] 실내 고온"
    elif temperature <= NORMAL_TEMP_MAX:
        temp_state = "NORMAL"
        state_msg = "[적정 상태] 온도 적정"
    elif temperature <= HALF_OPEN_TEMP_MAX:
        temp_state = "VENTILATION"
        state_msg = "[환기 상태] 온도 상승"
    else:
        temp_state = "VENTILATION"
        state_msg = "[환기 상태] 높은 온도"

    set_system_state(temp_state, state_msg)

    # --- 2) 창문 제어 (window_mode와 연동) ---
    if window_mode == "auto":
        if temp_state == "WARNING":
            if temperature is None:
                set_window(WINDOW_CLOSED)
            else:
                set_window(WINDOW_OPEN)
        elif temp_state == "RAIN":
            set_window(WINDOW_CLOSED, is_rain=True)
        elif temp_state == "WAITING":
            set_window(WINDOW_CLOSED)
        elif temp_state == "NORMAL":
            set_window(WINDOW_CLOSED)
        elif temp_state == "VENTILATION":
            if temperature <= HALF_OPEN_TEMP_MAX:
                set_window(WINDOW_HALF)
            else:
                set_window(WINDOW_OPEN)
    else:
        # 수동 모드이더라도 비가 감지되면 강제로 창문 닫기 (우천 안전장치)
        if temp_state == "RAIN":
            set_window(WINDOW_CLOSED, is_rain=True)

    # --- 터치 센서를 통한 수동/자동 조명 및 전체 자동 복귀 ---
    if touch1.value() == 1:
        light_mode = "manual"
        rgb_red()
        print("터치 1 ➔ RGB 빨간색 (수동)")
    elif touch2.value() == 1:
        light_mode = "manual"
        rgb_green()
        print("터치 2 ➔ RGB 초록색 (수동)")
    elif touch3.value() == 1:
        light_mode = "manual"
        rgb_blue()
        print("터치 3 ➔ RGB 파란색 (수동)")
    elif touch4.value() == 1:
        light_mode = "auto"
        window_mode = "auto"
        rgb_off()
        print("터치 4 ➔ 조명 & 창문 전체 자동 모드 복귀")

    # --- 조도 센서 기반 자동 조명 (light_mode가 "auto"일 때만 동작) ---
    if light_mode == "auto":
        cds_value = cds.read()
        if cds_value > DARK_THRESHOLD:
            rgb_white()
        else:
            rgb_off()

    # --- 터미널 상시 로그 출력 ---
    occupancy_str = "있음" if occupied else "없음"
    rain_str = "비 옴" if rain_value == 0 else "비 안 옴"

    print(
        "재실:", occupancy_str,
        "| 조도:", cds.read(),
        "| 빗물:", rain_str,
        "| 온도:", temperature,
        "| 상태:", current_state,
        "| 창문모드:", window_mode,
        "| 조명모드:", light_mode,
        "| 음향:", "ON" if sound_enabled else "OFF"
    )

    sleep(0.1)
