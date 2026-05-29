# MASTER_PROMPT.md

# EARTH GUARDIAN AI
AI-Powered Cinematic Environmental Experience

---

# PROJECT GOAL

Build a futuristic cinematic AI experience where players heal a dying Earth using real-time hand gestures.

The project should feel like:
- a science museum installation
- a cinematic AI demo
- a futuristic environmental experience

NOT like:
- a normal student project
- a complex open-world game

The experience duration should be:
1–3 minutes.

The focus is:
- visual immersion
- cinematic feedback
- environmental storytelling
- gesture interaction

---

# TECH STACK

## CORE ENGINE
- Unity 2022 LTS
- Universal Render Pipeline (URP)

## AI + COMPUTER VISION
- Python 3.11
- MediaPipe
- OpenCV

## COMMUNICATION
- Python WebSocket Server
- Unity WebSocket Client

## AUDIO
- Unity Audio System
- ElevenLabs AI Narration

## VISUALS
- Unity Particle System
- Bloom
- Volumetric Fog
- Cinematic Lighting

---

# PROJECT STRUCTURE

EARTH_GUARDIAN_AI/

├── MASTER_PROMPT.md

├── docs/
│   ├── 01_PROJECT_OVERVIEW.md
│   ├── 02_SETUP_GUIDE.md
│   ├── 03_GESTURE_SYSTEM.md
│   ├── 04_WEBSOCKET_SYSTEM.md
│   ├── 05_UNITY_SCENE.md
│   ├── 06_PARTICLE_SYSTEM.md
│   ├── 07_EARTH_ENGINE.md
│   ├── 08_BOSS_SYSTEM.md
│   ├── 09_AUDIO_SYSTEM.md
│   ├── 10_UI_SYSTEM.md
│   ├── 11_GAME_FLOW.md
│   └── 12_FINAL_POLISH.md

├── python/
│   ├── gesture_detector.py
│   ├── websocket_server.py
│   └── requirements.txt

├── unity/

└── assets/

---

# CORE EXPERIENCE FLOW

1. Intro cinematic
2. Earth appears dying
3. Webcam activates
4. Hand gestures unlock powers
5. Player heals Earth
6. Pollution boss appears
7. Final Earth restoration
8. Ending narration
9. Leaderboard screen

---

# REQUIRED GESTURES

ONLY use these 4 gestures.

1. Open Palm
→ Rain Power

2. Both Hands Up
→ Forest Growth

3. Swipe Left
→ Wind Blast

4. Fist
→ Attack Pollution Boss

No additional gestures allowed.

---

# SYSTEM ARCHITECTURE

Webcam
↓
MediaPipe Hand Tracking
↓
Gesture Recognition
↓
Python WebSocket Server
↓
Unity WebSocket Client
↓
Unity Event Manager
↓
Particle Effects
↓
Earth Health Engine
↓
Audio + Narration
↓
Final Cinematic Output

---

# UNITY REQUIREMENTS

Use:
- URP
- Cinemachine
- Post Processing
- Bloom
- Fog
- Camera Shake
- Dynamic Lighting

Do NOT:
- create open world systems
- create realistic physics simulation
- create multiplayer networking

Only create:
- one cinematic scene

---

# PYTHON REQUIREMENTS

Use:
- MediaPipe Hand Tracking
- OpenCV webcam feed
- gesture classification
- WebSocket communication

The Python system must:
- continuously detect gestures
- send gesture events to Unity
- include cooldown system
- include confidence threshold

---

# GESTURE DETECTION RULES

Use:
- large gestures
- slow movements
- stable tracking

Avoid:
- finger micro gestures
- complex hand signs
- fast motion tracking

Gesture trigger should only occur if:
- confidence > 0.8
- stable for 0.5 seconds

---

# UNITY EVENT SYSTEM

Every gesture triggers:
1. VFX
2. audio
3. Earth health change
4. environmental transformation

All systems must connect through:
GameEventManager.cs

---

# EARTH HEALTH ENGINE

Earth health range:
0 → 100

## EARTH STATES

0–25
Dead Earth
- smoke
- fire
- dark sky
- cracked atmosphere

25–60
Healing Earth
- reduced smoke
- green glow
- cleaner sky

60–100
Healthy Earth
- birds
- blue ocean
- sunlight
- nature ambience

---

# PARTICLE SYSTEM REQUIREMENTS

## Rain Power
- rain particles
- thunder
- lightning flash

## Forest Power
- grass growth
- leaves particles
- green energy glow

## Wind Power
- smoke clearing
- wind trails
- environmental push effects

## Boss Attack
- explosions
- dark smoke
- shockwave particles

Particle effects must trigger instantly after gesture detection.

---

# POLLUTION BOSS

Boss Name:
Pollution Titan

Boss Design:
- giant smoke creature
- floating dark energy
- environmental corruption

Boss appears after Earth health reaches 50.

Boss mechanics:
- health bar
- attack animation
- weakens environment
- defeated using fist gesture

Do NOT create advanced AI behavior.
Use scripted cinematic behavior only.

---

# AUDIO SYSTEM

Required audio:
- cinematic background music
- thunder
- wind
- fire
- boss roar
- Earth heartbeat
- healing ambience

Narration should feel:
- emotional
- cinematic
- futuristic

Use deep cinematic AI voice.

---

# UI REQUIREMENTS

Create:
- Earth health bar
- Boss health bar
- Gesture indicator
- Final score screen
- Leaderboard screen

UI style:
- futuristic
- holographic
- minimal

---

# GAME FLOW

## INTRO
Earth dying cinematic.

## ACTIVATION
Player detected.

## HEALING
Player uses powers.

## BOSS FIGHT
Pollution Titan appears.

## FINAL RESTORATION
Earth restored.

## ENDING
Narration + leaderboard.

---

# PERFORMANCE RULES

Target:
60 FPS minimum.

Avoid:
- excessive physics
- ultra high-poly assets
- heavy real-time shadows
- overuse of particles

Optimize for:
projector-based exhibition.

---

# VISUAL STYLE

Style:
- realistic cinematic
- dark sci-fi atmosphere
- environmental storytelling

Visual inspiration:
- Interstellar
- Avengers environmental portals
- cinematic museum installations

---

# IMPORTANT DEVELOPMENT PRIORITIES

Priority Order:

1. Stable gesture tracking
2. Instant visual response
3. Cinematic audio
4. Environmental transformation
5. Boss fight
6. UI polish

---

# DEVELOPMENT STRATEGY

DO:
- fake complexity visually
- use cinematic illusion
- prioritize atmosphere
- prioritize emotional impact

DO NOT:
- build deep gameplay systems
- build multiple scenes
- build advanced AI NPCs

---

# FINAL EXPERIENCE TARGET

The audience should feel:

“I just controlled nature using AI.”

The project should create:
- excitement
- emotional reaction
- visual immersion
- environmental awareness

END OF MASTER PROMPT
