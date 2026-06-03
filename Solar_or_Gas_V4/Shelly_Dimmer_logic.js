/**
 * Shelly Dimmer 2: Photovoltaic Excess Power Manager
 * --------------------------------------------------
 * Manages a resistive heater to optimize solar self-consumption.
 * 
 * Features:
 * - Dynamic Power Balancing: Matches heater load to solar export via LUT.
 * - Valve Orchestration: Interfaces with ESP32 to switch Solar/Gas sources.
 * - Thermal Safety: Hard-coded 90°C overheat protection with hysteresis.
 * - Stability: Daily 03:00 AM auto-reboot to prevent RAM fragmentation.
 * 
 * Hardware: Shelly Dimmer 2, Shelly EM, ESP32, DS18B20.
 * Version: 4.2 (Stability Focused)
 * Author: David / Project Termossifão
 * --------------------------------------------------
 */

// Consolidated Configuration
let CONFIG = {
  EM_IP: "192.168.1.129",  // IP from Shelly EM (House )
  SENSOR_ID: 100,          // DS18B20 Sensor ID
  MAX_HEATER_TEMP: 90.0,   // Maximum safety temperature for heater
  RECOVERY_TEMP: 80.0,     // Allow heater back on after overheat
  VALVE_TARGET_TEMP: 35.0, // Above this, solar is sufficient; below this, valve switches to gas
  VALVE_HYSTERESIS: 2.0,   // Hysteresis for valve control (e.g., open if < 33C, close if >= 35C)
  ESP_IP: "192.168.1.100", // IP of the ESP32 for data sync and valve control
  VALVE_CHECK_INTERVAL: 15000, // Check valve every 15 seconds
};

var overheatActive = false; // Safety lock flag
var lastValveState = null; // Tracks "solar" or "gas" to prevent redundant calls

// Global state to share grid power safely between callbacks
var STATE = {
  grid_p: null
};

// --- Manual Log Commands ---

// Power table (from real data)
let LUT = [
  { b: 40, p: 90 },
  { b: 41, p: 105 },
  { b: 43, p: 139 },
  { b: 45, p: 181 },
  { b: 47, p: 216 },
  { b: 49, p: 256 },
  { b: 50, p: 270 },
  { b: 51, p: 302 },
  { b: 52, p: 328 },
  { b: 53, p: 351 },
  { b: 54, p: 382 },
  { b: 55, p: 412 },
  { b: 56, p: 436 },
  { b: 57, p: 468 },
  { b: 58, p: 528 },
  { b: 59, p: 558 },
  { b: 60, p: 610 },
  { b: 61, p: 650 },
  { b: 62, p: 687 },
  { b: 63, p: 722 },
  { b: 64, p: 748 },
  { b: 65, p: 780 },
  { b: 66, p: 813 },
  { b: 67, p: 842 },
  { b: 68, p: 854 },
  { b: 69, p: 895 },
  { b: 70, p: 922 },
];

// Helper to call ESP32
function notifyESP32(endpoint) {
  var ip = CONFIG.ESP_IP;
  var url = "http://" + ip + "/" + endpoint;
  print("Notifying ESP32: " + url);
  
  Shelly.call("HTTP.GET", { url: url }, function(res, err, msg) {
    if (err !== 0) {
      print("Failed to notify ESP32, error: " + err);
    } else {
      print("ESP32 notified successfully.");
    }
  });
}

// Function to find the ideal brightness based on available solar power for the heater
function getTargetBrightness(available_power) {
  let target_b = 0; // Default to OFF if power is < 103W
  for (let i = 0; i < LUT.length; i++) {
    if (available_power >= LUT[i].p) {
      target_b = LUT[i].b; // Increase until finding the correct step
    }
  }
  return target_b;
}

// --- Callback Handlers (Defined Globally to save memory) ---

function handleTempLogic(tRes, tErr) {
  var temp = (tRes && typeof tRes.tC !== 'undefined') ? tRes.tC : null;
  
  if (tErr !== 0 || temp === null || temp < -5 || temp > 115) {
    print("SAFETY ERROR: Faulty sensor. Turning heater OFF.");
    Shelly.call("Light.Set", { id: 0, on: false });
    return;
  }

  // Overheat Lock Logic
  if (temp >= CONFIG.MAX_HEATER_TEMP) {
    if (!overheatActive) {
      print("SAFETY: Overheat (" + temp + "C). Heater LOCKED OFF until 80C.");
      overheatActive = true;
      Shelly.call("Light.Set", { id: 0, on: false });
    }
    return;
  }

  if (overheatActive && temp <= CONFIG.RECOVERY_TEMP) {
    print("SAFETY: Cooled to " + temp + "C. Re-enabling automation.");
    overheatActive = false;
  }

  if (overheatActive) return;

  if (STATE.grid_p !== null) {
    Shelly.call("Light.GetStatus", { id: 0 }, function(status) {
      var heater_p = status.apower; // Real consumption of the resistance
      var grid_p = STATE.grid_p;
      if (!status.output) {
        if (grid_p <= -150) Shelly.call("Light.Set", { id: 0, on: true, brightness: 55 });
      } else {
        if (grid_p > 100 || grid_p < -100) {
          var target_b = getTargetBrightness(heater_p - grid_p);
          if (target_b === 0) Shelly.call("Light.Set", { id: 0, on: false });
          else if (Math.abs(target_b - status.brightness) > 2) 
            Shelly.call("Light.Set", { id: 0, brightness: target_b });
        }
      }
    });
  }
}

function handleValveLogic(res, err) {
  if (err !== 0) {
    print("Error getting temp for valve control.");
    return;
  }
  
  var t = res.tC;
  print("Valve Logic | Temp: " + t + "C | Last State: " + (lastValveState || "Unknown"));

  // Proactively push the current temperature to the ESP32
  var updateUrl = "http://" + CONFIG.ESP_IP + "/update_temp?t=" + t;
  Shelly.call("HTTP.GET", { url: updateUrl }, null); // Explicit null callback for fire-and-forget

  // Move to GAS if water is cold
  if (t < CONFIG.VALVE_TARGET_TEMP && lastValveState !== "gas") { 
    lastValveState = "gas";
    notifyESP32("heating_schedule_end");
  } 
  // Move back to SOLAR if water is hot (Target + Hysteresis)
  else if (t >= (CONFIG.VALVE_TARGET_TEMP + CONFIG.VALVE_HYSTERESIS) && lastValveState !== "solar") { 
    lastValveState = "solar";
    notifyESP32("heating_schedule_start");
  }
}

HTTPServer.registerEndpoint("valve_update", function(req, res) {
  if (req.query && req.query.state) {
    lastValveState = req.query.state;
    print("ESP32 Feedback: Valve position confirmed as " + lastValveState);
  }
  res.code = 200;
  res.send();
});

function adjustHeater() {
  Shelly.call("HTTP.GET", { url: "http://" + CONFIG.EM_IP + "/status" }, function(res, err_code) {
    var grid_p = null;
    if (err_code === 0 && res && res.code === 200 && res.body) {
      var em_data = JSON.parse(res.body);
      grid_p = em_data.emeters[0].power;
    }
    
    STATE.grid_p = grid_p;

    print("STATUS | Grid: " + (grid_p !== null ? grid_p + "W" : "OFFLINE"));

    var sys = Shelly.getComponentStatus("sys");
    if (sys && sys.time) {
      var hour = sys.time.slice(0, 2) * 1;
      var minute = sys.time.slice(3, 5) * 1;

      // --- STABILITY: Daily Reboot at 03:00 AM ---
      if (hour === 3 && minute === 0) {
        print("STABILITY: Performing daily maintenance reboot...");
        Shelly.call("Shelly.Reboot");
        return;
      }

      if (hour < 8 || hour >= 19) {
        Shelly.call("Light.GetStatus", { id: 0 }, function(status) {
          if (status.output) Shelly.call("Light.Set", { id: 0, on: false });
        });
        return;
      }
    }

    Shelly.call("Temperature.GetStatus", { id: CONFIG.SENSOR_ID }, handleTempLogic);
  });
}

function valveControlLoop() {
  Shelly.call("Temperature.GetStatus", { id: CONFIG.SENSOR_ID }, handleValveLogic);
}

// Run heater adjustment cycle every 5 seconds (5000ms)
Timer.set(5000, true, adjustHeater);

// Run valve control loop every 15 seconds
Timer.set(CONFIG.VALVE_CHECK_INTERVAL, true, valveControlLoop);