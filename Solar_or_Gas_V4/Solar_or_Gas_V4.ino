#include <WiFi.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// =================================================================
//                          CONFIGURATION
// =================================================================
// --- Wi-Fi Credentials ---
const char* ssid = "NOS-F080-PRO-2.4G";
const char* password = "QJT9NHNZ";

// --- Device IP Addresses ---
// Set a static IP for this ESP32 so the Shelly knows where to find it.
// Make sure this IP is outside your router's DHCP range.
IPAddress esp_ip(192, 168, 1, 100);
IPAddress gateway(192, 168, 1, 1);
IPAddress subnet(255, 255, 255, 0);

// IP address of your Shelly 1PM
const char* shelly_ip = "192.168.1.68"; // <-- CHANGE THIS

// --- Logic Parameters ---
const int VALVE_MOVE_DURATION_MS = 25000; // 25s pulse to move the valve (user specified)

// --- Hardware Pins ---
// Pins for the two relays controlling the three-way valve
const int VALVE_TO_SOLAR_PIN = 16; // Relay to set valve to solar deposit
const int VALVE_TO_GAS_PIN = 17; // Relay to set valve to gas burner

// =================================================================

// --- Global State Variables ---
bool isValveOnSolar; // Tracks the valve's current position
bool isValveMoving = false; // Flag to indicate if valve is currently in motion
unsigned long valveMoveStartTime = 0; // Timestamp when valve movement started
unsigned long lastTempUpdateTime = 0; // Tracks when we last received a temperature update
float lastKnownTemp = 0.0; // Track temp for display

LiquidCrystal_I2C lcd(0x27, 16, 2); // Set the LCD address to 0x27 for a 16 chars and 2 line display

WebServer server(80);
Preferences preferences;

// Helper to notify Shelly of the physical valve state
void notifyShellyValveState() {
  WiFiClient client;
  HTTPClient http;
  // Assuming script ID 1 as per Shelly script comments
  String stateStr = isValveOnSolar ? "solar" : "gas";
  String url = "http://" + String(shelly_ip) + "/script/1/valve_update?state=" + stateStr;
  
  Serial.print("Notifying Shelly of valve state: "); Serial.println(stateStr);
  http.begin(client, url);
  int httpCode = http.GET();
  if (httpCode > 0) {
    Serial.printf("Shelly notified. Code: %d\n", httpCode);
  } else {
    Serial.printf("Shelly notification failed: %s\n", http.errorToString(httpCode).c_str());
  }
  http.end();
}

void moveValve(bool targetIsSolar); // Forward declaration

// Sends a timed pulse to move the valve and saves the new state.
void moveValve(bool targetIsSolar) {
  // 1. Safety Check: Don't interrupt a move already in progress
  if (isValveMoving) {
    Serial.println("VALVE: Move ignored, valve is already moving.");
    return;
  }
  // Note: We removed the check (targetIsSolar == isValveOnSolar) so that
  // manual commands can "Force" a move if the system is out of sync.

  // Safety: Ensure both are OFF before switching to prevent overlap
  digitalWrite(VALVE_TO_SOLAR_PIN, LOW);
  digitalWrite(VALVE_TO_GAS_PIN, LOW);
  delay(100); // Dead-time to allow mechanical relays to release

  // 2. Perform the move
  isValveOnSolar = targetIsSolar; // Update state immediately so redundant calls are blocked

  if (targetIsSolar) {
    Serial.println("VALVE: Sending pulse to move to SOLAR deposit...");
    lcd.setCursor(0, 1);
    lcd.print("Valve: Moving->S");
    digitalWrite(VALVE_TO_SOLAR_PIN, HIGH);
  } else {
    Serial.println("VALVE: Sending pulse to move to GAS burner...");
    lcd.setCursor(0, 1);
    lcd.print("Valve: Moving->G");
    digitalWrite(VALVE_TO_GAS_PIN, HIGH);
  }

  // 3. Set flags for non-blocking movement completion in loop()
  valveMoveStartTime = millis();
  isValveMoving = true;
  
  // Update LCD to show it's moving
  lcd.setCursor(0, 1);
  lcd.print("Valve: Moving... ");
}

// --- Web Server Handlers ---
void handleHeatingScheduleStart() {
  Serial.println("Received: Valve to SOLAR (Temp low)");
  moveValve(true); 
  server.send(200, "text/plain", "OK");
}

void handleHeatingScheduleEnd() {
  Serial.println("Received: Valve to GAS (Temp sufficient)");
  moveValve(false);
  server.send(200, "text/plain", "OK");
}

void handleNotFound() {
  server.send(404, "text/plain", "Not Found");
}

void handleUpdateTemp() {
  if (server.hasArg("t")) {
    float temperature = server.arg("t").toFloat();
    Serial.print("Received temperature update from Shelly: ");
    Serial.println(temperature);

    lastKnownTemp = temperature;
    lcd.setCursor(0, 0);
    lcd.printf("SolarTemp: %.1fC", lastKnownTemp);

    lastTempUpdateTime = millis(); // We heard from the Shelly, reset the watchdog timer
    server.send(200, "text/plain", "OK");
  } else {
    server.send(400, "text/plain", "Missing 't' parameter");
  }
}

void setup() {
  Serial.begin(115200);

  // Init LCD
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("System Starting");

  // Setup relay pins
  pinMode(VALVE_TO_SOLAR_PIN, OUTPUT);
  pinMode(VALVE_TO_GAS_PIN, OUTPUT);
  digitalWrite(VALVE_TO_SOLAR_PIN, LOW);
  digitalWrite(VALVE_TO_GAS_PIN, LOW);

  // Initialize Preferences and load the last known valve state
  preferences.begin("valve_control", false); // 'valve_control' is our namespace
  // Load the last state. Default to 'false' (Gas) if it's the first boot.
  isValveOnSolar = preferences.getBool("isSolar", false); 
  Serial.println("\n========================================");
  Serial.printf("System starting. Initial valve state: %s\n", isValveOnSolar ? "SOLAR" : "GAS");
  Serial.println("========================================");

  lcd.setCursor(0, 1);
  lcd.print("Connecting WiFi");

  // Connect to Wi-Fi
  Serial.print("Connecting to ");
  Serial.println(ssid);
  WiFi.mode(WIFI_STA); // Ensure Station mode
  WiFi.setSleep(false); // REQUIRED for ESP32-32E stability
  WiFi.config(esp_ip, gateway, subnet);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected.");
  Serial.print("ESP32 IP address: ");
  Serial.println(WiFi.localIP());

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Waiting for Data");
  lcd.setCursor(0, 1);
  lcd.printf("Valve: %s", isValveOnSolar ? "SOLAR" : "GAS  ");

  // Setup web server endpoints
  server.on("/heating_schedule_start", handleHeatingScheduleStart);
  server.on("/heating_schedule_end", handleHeatingScheduleEnd);
  server.on("/update_temp", handleUpdateTemp);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("HTTP server started.");
}

void loop() {
  // --- Non-blocking WiFi Reconnect ---
  static unsigned long lastWiFiCheck = 0;
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWiFiCheck > 10000) { // Try every 10 seconds
      lastWiFiCheck = millis();
      Serial.println("WiFi lost. Attempting background reconnect...");
      WiFi.config(esp_ip, gateway, subnet);
      WiFi.begin(ssid, password);
      WiFi.setSleep(false);
    }
  }

  // Only handle web requests if connected
  if (WiFi.status() == WL_CONNECTED) {
    server.handleClient();
  }

  // --- Non-blocking Valve Movement Completion ---
  if (isValveMoving && millis() - valveMoveStartTime >= VALVE_MOVE_DURATION_MS) {
    // Movement duration has passed, cut power to relays
    digitalWrite(VALVE_TO_SOLAR_PIN, LOW);
    digitalWrite(VALVE_TO_GAS_PIN, LOW);
    Serial.println("VALVE: Pulse complete. Relays OFF.");

    // Update state and save
    isValveMoving = false;
    // The `moveValve` function already set `isValveOnSolar` based on the target
    preferences.putBool("isSolar", isValveOnSolar);
    Serial.printf("New valve state saved: %s\n", isValveOnSolar ? "SOLAR" : "GAS");
    
    // Update LCD with final state
    lcd.setCursor(0, 1);
    lcd.printf("Valve: %s    ", isValveOnSolar ? "SOLAR" : "GAS  ");

    // Notify Shelly that movement is done and state is verified
    notifyShellyValveState();
  }

  // --- Watchdog Logic ---
  // Monitor if temperature updates are still being received from the Shelly.
  const long WATCHDOG_INTERVAL = 65000; // Poll if no update received for ~65 seconds
  static unsigned long lastWatchdogWarning = 0;

  if (millis() - lastTempUpdateTime > WATCHDOG_INTERVAL && millis() - lastWatchdogWarning > 10000) {
    Serial.println("WATCHDOG: No data from Shelly!");
    lcd.setCursor(0, 0);
    lcd.print("COMM ERROR!     ");
    lastWatchdogWarning = millis();
  }
}
