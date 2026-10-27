# KAGUA-LIVESTOCK: Super Intelligent IoT Poultry Monitoring & Early Detection System

## Overview

**KAGUA-LIVESTOCK** is an automated, IoT-powered remote monitoring solution designed to bridge the gap between farmers in the city and their poultry houses on the ground. By combining continuous sensor telemetry with camera vision, the system provides real-time health tracking, environmental metrics, and instant anomaly alerts directly through a centralized multi-user web application.

---

## System Architecture & Hardware Setup

The system deployment inside the poultry house utilizes a modular microcontroller setup running independently without requiring a permanent computer connection:

- **Processing Unit (ESP32 / ESP32-CAM):** Powered via a stable DC adapter with a backup battery, handling local sensor data collection and executing firmware routines autonomously.
- **Environmental Sensor Array:**
  - **Temperature and Humidity Sensors (DHT22):** Continuously track ambient coop microclimates to preemptively flag conditions leading to heat stress or hypothermia in chicks.
  - **Ammonia Gas Sensors (MQ-137):** Monitor harmful gas concentrations near floor level to ensure air quality remains within safe thresholds for respiratory health.
- **Vision and Behavior Tracking (ESP32-CAM Module):** Integrated compact camera units capture regular visual snapshots and live behavioral feeds of broilers and layers, tracking movement patterns, clustering, and posture changes indicative of stress or illness.

---

## Data Pipeline: From Edge to Cloud

1. **Local Capture:** The ESP32 collects environmental metrics while the ESP32-CAM snaps visual frames of the flock.
2. **Cloud Ingestion via Wi-Fi:** Microcontrollers securely transmit sensor payloads and image files directly to a centralized **Supabase** database and storage bucket over the local farm Wi-Fi router.
3. **Centralized Database Management:** Supabase stores real-time time-series telemetry and historical logs, driving fast queries for the application layer.

---

## Multi-User Web Application & Access Control

- **Multi-Tenant Isolation:** Security and data privacy are paramount. Administrator-managed onboarding ensures secure, role-based access control where users securely log in to view data exclusively tied to their specific farm cages and houses.
- **Remote Dashboard Visualization:** Farmers sitting in the city can log into their dashboard to check live temperature graphs, air quality levels, and recent camera snapshots from anywhere.

---

## Meta AI Integration

- **Meta Muse Spark / Muse Spark Open:** Analyzes visual behavior (e.g., detecting huddling, heat stress panting, wing-drooping) alongside environmental trends inside **n8n** automation workflows.
- **Muse Image Generation:** Generates assets for the front-end web application.

---

## Quick Start / Firmware Setup

The ESP32-CAM firmware is written in C++ (compatible with the Arduino IDE or ESP-IDF). Below is the core telemetry and capture loop structure:

```cpp
#include <WiFi.h>
#include <HTTPClient.h>
#include "esp_camera.h"
#include "DHT.h"

const char* ssid = "YOUR_FARM_WIFI";
const char* password = "YOUR_WIFI_PASSWORD";
const char* supabaseUrl = "https://your-project.supabase.co/rest/v1/telemetry";
const char* supabaseApiKey = "YOUR_SUPABASE_ANON_KEY";

#define DHTPIN 4
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(115200);
  dht.begin();
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
}

void loop() {
  float humidity = dht.readHumidity();
  float temperature = dht.readTemperature();
  int ammoniaVal = analogRead(A0); // Read MQ-137 input

  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Camera capture failed");
    return;
  }

  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(supabaseUrl);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("apikey", supabaseApiKey);
    http.addHeader("Authorization", String("Bearer ") + supabaseApiKey);

    String payload = "{\"temperature\": " + String(temperature) +
                     ", \"humidity\": " + String(humidity) +
                     ", \"ammonia_ppm\": " + String(ammoniaVal) + "}";

    int httpResponseCode = http.POST(payload);
    http.end();
  }

  esp_camera_fb_return(fb);
  delay(60000); // Check every 1 minute
}
```
