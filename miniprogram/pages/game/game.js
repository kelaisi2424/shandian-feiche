const STORAGE_KEY = "cute_runner_safety_v1"
const DAY_MS = 24 * 60 * 60 * 1000

const DEFAULT_SETTINGS = {
  playLimitMs: 8 * 60 * 1000,
  restMs: 3 * 60 * 1000,
  dailyStarLimit: 180
}

const PETS = [
  { id: "rabbit", name: "兔兔", emoji: "🐰", body: "#ff9ec5", trim: "#ff6f91", jump: 1.14 },
  { id: "cat", name: "喵喵", emoji: "🐱", body: "#ffd45a", trim: "#ff9f43", jump: 1.02 },
  { id: "panda", name: "熊猫", emoji: "🐼", body: "#f7f7f7", trim: "#343a54", jump: 1 },
  { id: "dog", name: "汪汪", emoji: "🐶", body: "#8fd3ff", trim: "#4a8df2", jump: 1.06 }
]

const REST_TIPS = [
  "看一看窗外远处，让眼睛放松一下。",
  "去喝几口水，再回来会更有精神。",
  "和爸爸妈妈说说刚才收到了几颗星星。",
  "站起来伸伸手臂，身体也要加油。"
]

const FLOATING = ["★", "●", "✦", "☁", "❤", "✶", "☀", "◆"]

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function mmss(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s < 10 ? "0" : ""}${s}`
}

function minuteText(ms) {
  return `${Math.round(ms / 60000)}分钟`
}

function makeQuestion() {
  const a = Math.floor(4 + Math.random() * 8)
  const b = Math.floor(3 + Math.random() * 7)
  return { text: `${a} + ${b}`, answer: String(a + b) }
}

Page({
  data: {
    screen: "title",
    showParentPanel: false,
    pets: PETS,
    selectedPet: "rabbit",
    floatingStars: [],
    score: 0,
    coins: 0,
    stage: 1,
    bestScore: 0,
    todayStars: 0,
    dailyStarLimit: DEFAULT_SETTINGS.dailyStarLimit,
    playLimitText: minuteText(DEFAULT_SETTINGS.playLimitMs),
    restText: minuteText(DEFAULT_SETTINGS.restMs),
    sessionLeftMs: DEFAULT_SETTINGS.playLimitMs,
    sessionTimeText: mmss(DEFAULT_SETTINGS.playLimitMs),
    goalText: "收集 12 颗星星",
    goalPercent: 0,
    overTitle: "真棒！",
    restMessage: "小朋友，眼睛要休息一下啦。",
    restCountdownText: "3:00",
    restProgress: 0,
    restTip: REST_TIPS[0],
    parentQuestion: makeQuestion(),
    parentAnswer: ""
  },

  onLoad() {
    this.settings = { ...DEFAULT_SETTINGS }
    this.safety = this.loadSafety()
    this.game = null
    this.canvas = null
    this.ctx = null
    this.width = 0
    this.height = 0
    this.dpr = 1
    this.frameId = 0
    this.lastFrame = 0
    this.sessionStart = 0
    this.sessionUsedBeforePause = 0
    this.lastHudUpdate = 0
    this.touchStart = null
    this.parentDraft = { ...this.settings }
    this.restTimer = null

    this.setData({
      floatingStars: this.makeFloatingStars(),
      bestScore: this.safety.bestScore || 0,
      todayStars: this.safety.todayStars || 0,
      dailyStarLimit: this.settings.dailyStarLimit,
      playLimitText: minuteText(this.settings.playLimitMs),
      restText: minuteText(this.settings.restMs),
      sessionLeftMs: this.settings.playLimitMs,
      sessionTimeText: mmss(this.settings.playLimitMs)
    })

    this.initCanvas()
    this.restTimer = setInterval(() => this.tickRest(), 500)
    this.tickRest()
  },

  onUnload() {
    this.stopLoop()
    if (this.restTimer) clearInterval(this.restTimer)
  },

  loadSafety() {
    const raw = wx.getStorageSync(STORAGE_KEY) || {}
    const key = todayKey()
    const safety = {
      day: raw.day || key,
      todayStars: raw.todayStars || 0,
      bestScore: raw.bestScore || 0,
      restUntil: raw.restUntil || 0,
      settings: raw.settings || DEFAULT_SETTINGS
    }
    if (safety.day !== key) {
      safety.day = key
      safety.todayStars = 0
      safety.restUntil = 0
    }
    this.settings = { ...DEFAULT_SETTINGS, ...safety.settings }
    wx.setStorageSync(STORAGE_KEY, safety)
    return safety
  },

  saveSafety() {
    wx.setStorageSync(STORAGE_KEY, {
      day: todayKey(),
      todayStars: this.safety.todayStars,
      bestScore: this.safety.bestScore,
      restUntil: this.safety.restUntil,
      settings: this.settings
    })
  },

  initCanvas() {
    wx.createSelectorQuery()
      .in(this)
      .select("#gameCanvas")
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0]) return
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        this.canvas = res[0].node
        this.ctx = this.canvas.getContext("2d")
        this.width = res[0].width
        this.height = res[0].height
        this.dpr = info.pixelRatio || 1
        this.canvas.width = this.width * this.dpr
        this.canvas.height = this.height * this.dpr
        this.ctx.scale(this.dpr, this.dpr)
        this.drawHomeScene(0)
      })
  },

  makeFloatingStars() {
    return Array.from({ length: 16 }).map((_, i) => ({
      id: i,
      icon: FLOATING[i % FLOATING.length],
      left: 5 + Math.random() * 90,
      delay: Math.random() * 8,
      duration: 8 + Math.random() * 7
    }))
  },

  selectPet(e) {
    this.setData({ selectedPet: e.currentTarget.dataset.id })
    this.tapFeedback()
    this.drawHomeScene(Date.now() / 1000)
  },

  showGuide() {
    this.setData({ screen: "guide" })
  },

  backHome() {
    this.stopLoop()
    this.setData({ screen: "title" })
    this.drawHomeScene(Date.now() / 1000)
  },

  startGame() {
    const now = Date.now()
    if (this.safety.restUntil > now) {
      this.showRestScreen("休息还没结束哦，等倒计时完成再继续。")
      return
    }
    if (this.safety.todayStars >= this.settings.dailyStarLimit) {
      this.showRestScreen("今天的星星已经收满啦，明天再来玩。")
      return
    }

    const goal = 12
    this.game = {
      lane: 1,
      targetLane: 1,
      jumpY: 0,
      jumpV: 0,
      lives: 3,
      score: 0,
      coins: 0,
      stage: 1,
      starsInStage: 0,
      stageGoal: goal,
      speed: 240,
      spawnIn: 0.3,
      time: 0,
      shake: 0,
      invincible: 0,
      items: [],
      particles: [],
      message: "",
      messageT: 0
    }
    this.sessionStart = now
    this.sessionUsedBeforePause = 0
    this.lastFrame = 0
    this.lastHudUpdate = 0
    this.setData({
      screen: "playing",
      score: 0,
      coins: 0,
      stage: 1,
      goalText: `收集 ${goal} 颗星星`,
      goalPercent: 0,
      sessionLeftMs: this.settings.playLimitMs,
      sessionTimeText: mmss(this.settings.playLimitMs)
    })
    this.tapFeedback()
    this.loop(0)
  },

  pauseGame() {
    if (!this.game || this.data.screen !== "playing") return
    this.sessionUsedBeforePause += Date.now() - this.sessionStart
    this.stopLoop()
    this.setData({ screen: "paused" })
    this.draw()
  },

  resumeGame() {
    if (!this.game || this.data.screen !== "paused") return
    this.sessionStart = Date.now()
    this.lastFrame = 0
    this.setData({ screen: "playing" })
    this.loop(0)
  },

  stopLoop() {
    if (this.canvas && this.frameId && this.canvas.cancelAnimationFrame) {
      this.canvas.cancelAnimationFrame(this.frameId)
      this.frameId = 0
    } else if (this.frameId) {
      clearTimeout(this.frameId)
      this.frameId = 0
    }
  },

  loop(ts) {
    if (this.data.screen !== "playing") return
    if (!this.lastFrame) this.lastFrame = ts || 1
    const dt = clamp(((ts || this.lastFrame) - this.lastFrame) / 1000, 0.001, 0.033)
    this.lastFrame = ts || this.lastFrame + 16
    this.updateSession()
    this.updateGame(dt)
    this.draw()
    if (this.canvas && this.canvas.requestAnimationFrame) {
      this.frameId = this.canvas.requestAnimationFrame((t) => this.loop(t))
    } else {
      this.frameId = setTimeout(() => this.loop(this.lastFrame + 16), 16)
    }
  },

  updateSession() {
    const used = this.sessionUsedBeforePause + (Date.now() - this.sessionStart)
    const left = this.settings.playLimitMs - used
    if (Date.now() - this.lastHudUpdate > 250) {
      this.lastHudUpdate = Date.now()
      this.setData({
        sessionLeftMs: Math.max(0, left),
        sessionTimeText: mmss(left)
      })
    }
    if (left <= 0) {
      this.enterRest("小朋友，你已经连续玩了一会儿啦。现在让眼睛休息一下。")
    }
  },

  updateGame(dt) {
    const g = this.game
    if (!g) return
    g.time += dt
    g.speed = clamp(240 + (g.stage - 1) * 22 + g.time * 2.2, 240, 430)
    g.lane += (g.targetLane - g.lane) * Math.min(1, dt * 11)

    if (g.jumpY > 0 || g.jumpV > 0) {
      g.jumpV -= 2200 * dt
      g.jumpY = Math.max(0, g.jumpY + g.jumpV * dt)
      if (g.jumpY === 0 && g.jumpV < 0) g.jumpV = 0
    }

    g.spawnIn -= dt
    if (g.spawnIn <= 0) {
      this.spawnItem()
      g.spawnIn = Math.max(0.34, 0.8 - g.stage * 0.04 + Math.random() * 0.45)
    }

    for (let i = g.items.length - 1; i >= 0; i--) {
      const item = g.items[i]
      item.y += g.speed * dt
      item.spin += dt * 4
      if (item.y > this.height + 80) {
        g.items.splice(i, 1)
        continue
      }
      this.checkCollision(item, i)
    }

    for (let i = g.particles.length - 1; i >= 0; i--) {
      const p = g.particles[i]
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vy += 540 * dt
      p.life -= dt
      if (p.life <= 0) g.particles.splice(i, 1)
    }

    if (g.invincible > 0) g.invincible -= dt
    if (g.shake > 0) g.shake -= dt
    if (g.messageT > 0) g.messageT -= dt
  },

  spawnItem() {
    const g = this.game
    const lane = Math.floor(Math.random() * 3)
    const roll = Math.random()
    let kind = "star"
    if (roll > 0.74) kind = "cone"
    else if (roll > 0.58) kind = "coin"
    else if (roll > 0.52) kind = "heart"
    g.items.push({
      kind,
      lane,
      y: -70,
      spin: Math.random() * 6,
      wiggle: Math.random() * 6
    })
  },

  checkCollision(item, index) {
    const g = this.game
    if (!g) return
    const playerY = this.height * 0.76 - g.jumpY
    const playerX = this.laneX(g.lane, playerY)
    const itemX = this.laneX(item.lane, item.y)
    const dx = Math.abs(playerX - itemX)
    const dy = Math.abs(playerY - item.y)
    const hit = dx < 44 && dy < 54
    if (!hit) return

    if (item.kind === "cone") {
      if (g.jumpY > 38 || g.invincible > 0) return
      g.items.splice(index, 1)
      g.lives -= 1
      g.shake = 0.25
      g.invincible = 1.1
      g.message = "慢一点也没关系"
      g.messageT = 1.2
      this.makeParticles(playerX, playerY - 30, "#ff7a6d", 10)
      wx.vibrateShort({ type: "medium" })
      if (g.lives <= 0) this.gameOver("今天已经很努力啦！")
      return
    }

    g.items.splice(index, 1)
    if (item.kind === "star") {
      g.score += 20
      g.starsInStage += 1
      this.addDailyStar(1)
      this.makeParticles(itemX, item.y, "#ffd95e", 12)
      if (g.starsInStage >= g.stageGoal) this.nextStage()
    } else if (item.kind === "coin") {
      g.score += 8
      g.coins += 1
      this.makeParticles(itemX, item.y, "#ffb84d", 8)
    } else if (item.kind === "heart") {
      g.score += 15
      g.lives = Math.min(3, g.lives + 1)
      this.makeParticles(itemX, item.y, "#ff6f91", 10)
    }
    this.tapFeedback()
    this.updateHud()
  },

  addDailyStar(count) {
    this.safety.todayStars = Math.min(this.settings.dailyStarLimit, this.safety.todayStars + count)
    this.saveSafety()
    this.setData({ todayStars: this.safety.todayStars })
    if (this.safety.todayStars >= this.settings.dailyStarLimit) {
      this.enterRest("今天的星星已经收满啦，休息之后明天再继续。", DAY_MS)
    }
  },

  nextStage() {
    const g = this.game
    g.stage += 1
    g.starsInStage = 0
    g.stageGoal = Math.min(28, 12 + g.stage * 3)
    g.score += 60
    g.message = `第 ${g.stage} 关`
    g.messageT = 1.4
    this.makeParticles(this.width / 2, this.height * 0.38, "#8de36f", 28)
    this.updateHud()
  },

  updateHud() {
    const g = this.game
    if (!g) return
    this.setData({
      score: g.score,
      coins: g.coins,
      stage: g.stage,
      goalText: `收集 ${g.stageGoal} 颗星星`,
      goalPercent: Math.round((g.starsInStage / g.stageGoal) * 100)
    })
  },

  gameOver(title) {
    const g = this.game
    if (!g) return
    this.stopLoop()
    this.safety.bestScore = Math.max(this.safety.bestScore || 0, g.score)
    this.saveSafety()
    this.setData({
      screen: "over",
      overTitle: title,
      score: g.score,
      coins: g.coins,
      stage: g.stage,
      bestScore: this.safety.bestScore
    })
    this.draw()
  },

  enterRest(message, duration) {
    this.stopLoop()
    this.safety.restUntil = Date.now() + (duration || this.settings.restMs)
    this.saveSafety()
    this.showRestScreen(message)
  },

  showRestScreen(message) {
    this.setData({
      screen: "rest",
      restMessage: message,
      restTip: REST_TIPS[Math.floor(Math.random() * REST_TIPS.length)]
    })
    this.tickRest()
  },

  tickRest() {
    if (!this.safety) return
    const left = this.safety.restUntil - Date.now()
    if (left <= 0) {
      if (this.data.screen === "rest") {
        this.safety.restUntil = 0
        this.saveSafety()
        this.setData({ screen: "title" })
        this.drawHomeScene(Date.now() / 1000)
      }
      return
    }
    const total = Math.max(1, this.settings.restMs)
    this.setData({
      restCountdownText: mmss(left),
      restProgress: clamp(Math.round(((total - left) / total) * 100), 0, 100)
    })
  },

  moveLeft() {
    if (!this.game || this.data.screen !== "playing") return
    this.game.targetLane = clamp(this.game.targetLane - 1, 0, 2)
    this.tapFeedback()
  },

  moveRight() {
    if (!this.game || this.data.screen !== "playing") return
    this.game.targetLane = clamp(this.game.targetLane + 1, 0, 2)
    this.tapFeedback()
  },

  jump() {
    if (!this.game || this.data.screen !== "playing") return
    const pet = PETS.find((p) => p.id === this.data.selectedPet) || PETS[0]
    if (this.game.jumpY <= 2) {
      this.game.jumpV = 820 * pet.jump
      this.tapFeedback()
    }
  },

  onTouchStart(e) {
    const t = e.touches && e.touches[0]
    if (!t) return
    this.touchStart = { x: t.x, y: t.y, at: Date.now() }
  },

  onTouchMove() {},

  onTouchEnd(e) {
    if (!this.touchStart || this.data.screen !== "playing") return
    const t = e.changedTouches && e.changedTouches[0]
    if (!t) return
    const dx = t.x - this.touchStart.x
    const dy = t.y - this.touchStart.y
    const ax = Math.abs(dx)
    const ay = Math.abs(dy)
    if (ax > 34 && ax > ay) {
      if (dx > 0) this.moveRight()
      else this.moveLeft()
    } else {
      this.jump()
    }
    this.touchStart = null
  },

  openParentGate() {
    this.parentDraft = { ...this.settings }
    this.setData({
      showParentPanel: true,
      parentQuestion: makeQuestion(),
      parentAnswer: "",
      playLimitText: minuteText(this.parentDraft.playLimitMs),
      restText: minuteText(this.parentDraft.restMs)
    })
  },

  closeParentGate() {
    this.parentDraft = { ...this.settings }
    this.setData({
      showParentPanel: false,
      playLimitText: minuteText(this.settings.playLimitMs),
      restText: minuteText(this.settings.restMs)
    })
  },

  onParentAnswerInput(e) {
    this.setData({ parentAnswer: e.detail.value })
  },

  changePlayLimit(e) {
    const delta = Number(e.currentTarget.dataset.delta || 0)
    this.parentDraft.playLimitMs = clamp(this.parentDraft.playLimitMs + delta * 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000)
    this.setData({
      playLimitText: minuteText(this.parentDraft.playLimitMs)
    })
  },

  changeRestLimit(e) {
    const delta = Number(e.currentTarget.dataset.delta || 0)
    this.parentDraft.restMs = clamp(this.parentDraft.restMs + delta * 60 * 1000, 2 * 60 * 1000, 8 * 60 * 1000)
    this.setData({ restText: minuteText(this.parentDraft.restMs) })
  },

  saveParentSettings() {
    if (String(this.data.parentAnswer) !== String(this.data.parentQuestion.answer)) {
      wx.showToast({ title: "答案不对哦", icon: "none" })
      return
    }
    if (this.data.screen === "rest") {
      this.safety.restUntil = 0
      this.setData({ screen: "title" })
    }
    this.settings = { ...this.parentDraft }
    this.saveSafety()
    this.setData({
      showParentPanel: false,
      playLimitText: minuteText(this.settings.playLimitMs),
      restText: minuteText(this.settings.restMs),
      sessionLeftMs: this.settings.playLimitMs,
      sessionTimeText: mmss(this.settings.playLimitMs)
    })
    wx.showToast({ title: "已保存", icon: "success" })
    this.drawHomeScene(Date.now() / 1000)
  },

  tapFeedback() {
    wx.vibrateShort({ type: "light" })
  },

  laneX(lane, y) {
    const t = clamp(y / this.height, 0, 1)
    const road = this.width * (0.18 + t * 0.48)
    return this.width / 2 + (lane - 1) * road * 0.42
  },

  makeParticles(x, y, color, count) {
    const g = this.game
    if (!g) return
    for (let i = 0; i < count; i++) {
      const a = (Math.PI * 2 * i) / count + Math.random() * 0.4
      const sp = 80 + Math.random() * 160
      g.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 90,
        color,
        size: 3 + Math.random() * 5,
        life: 0.45 + Math.random() * 0.35,
        maxLife: 0.8
      })
    }
  },

  drawHomeScene(t) {
    if (!this.ctx) return
    const ctx = this.ctx
    this.clear()
    this.drawSky(t || 0)
    this.drawRoad(0)
    this.drawSideDecorations(t || 0)
    this.drawPet(this.width / 2, this.height * 0.73, this.height * 0.058, t || 0)
  },

  draw() {
    if (!this.ctx) return
    const g = this.game
    const shakeX = g && g.shake > 0 ? (Math.random() - 0.5) * 8 : 0
    const shakeY = g && g.shake > 0 ? (Math.random() - 0.5) * 8 : 0
    this.clear()
    this.ctx.save()
    this.ctx.translate(shakeX, shakeY)
    this.drawSky(g ? g.time : 0)
    this.drawRoad(g ? g.time : 0)
    this.drawSideDecorations(g ? g.time : 0)
    if (g) {
      this.drawItems()
      this.drawPlayer()
      this.drawParticles()
      this.drawLives()
      this.drawGameMessage()
    }
    this.ctx.restore()
  },

  clear() {
    this.ctx.clearRect(0, 0, this.width, this.height)
  },

  drawSky(t) {
    const ctx = this.ctx
    const sky = ctx.createLinearGradient(0, 0, 0, this.height)
    sky.addColorStop(0, "#7bdcff")
    sky.addColorStop(0.52, "#b8f0d2")
    sky.addColorStop(1, "#fff0a6")
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, this.width, this.height)

    ctx.fillStyle = "rgba(255,255,255,.9)"
    this.cloud((this.width * 0.18 + t * 18) % (this.width + 180) - 90, this.height * 0.16, 34)
    this.cloud((this.width * 0.72 - t * 12) % (this.width + 220), this.height * 0.25, 42)

    ctx.fillStyle = "#77c888"
    this.hill(-40, this.height * 0.52, this.width * 0.55, this.height * 0.18)
    ctx.fillStyle = "#5eb978"
    this.hill(this.width * 0.42, this.height * 0.54, this.width * 0.7, this.height * 0.2)
  },

  cloud(x, y, s) {
    const ctx = this.ctx
    ctx.beginPath()
    ctx.arc(x, y, s * 0.55, 0, Math.PI * 2)
    ctx.arc(x + s * 0.52, y - s * 0.18, s * 0.7, 0, Math.PI * 2)
    ctx.arc(x + s * 1.1, y, s * 0.5, 0, Math.PI * 2)
    ctx.fill()
  },

  hill(x, y, w, h) {
    const ctx = this.ctx
    ctx.beginPath()
    ctx.moveTo(x, this.height)
    ctx.quadraticCurveTo(x + w * 0.5, y - h, x + w, this.height)
    ctx.closePath()
    ctx.fill()
  },

  drawRoad(t) {
    const ctx = this.ctx
    const topY = this.height * 0.42
    const bottomY = this.height
    const topW = this.width * 0.22
    const bottomW = this.width * 1.16
    const cx = this.width / 2

    ctx.fillStyle = "#80d070"
    ctx.fillRect(0, topY, this.width, bottomY - topY)

    const rows = 18
    const offset = (t * 1.8) % 1
    for (let i = rows - 1; i >= 0; i--) {
      const a = clamp((i + offset) / rows, 0, 1)
      const b = clamp((i + 1 + offset) / rows, 0, 1)
      const y1 = topY + Math.pow(a, 1.78) * (bottomY - topY)
      const y2 = topY + Math.pow(b, 1.78) * (bottomY - topY)
      const w1 = topW + Math.pow(a, 1.22) * (bottomW - topW)
      const w2 = topW + Math.pow(b, 1.22) * (bottomW - topW)
      const shade = i % 2 === 0 ? "#606a7d" : "#566071"
      this.trapezoid(cx - w1 / 2, y1, cx + w1 / 2, y1, cx + w2 / 2, y2, cx - w2 / 2, y2, shade)

      const curb = i % 2 === 0 ? "#fff2f2" : "#ff6f6f"
      this.trapezoid(cx - w1 / 2 - w1 * 0.035, y1, cx - w1 / 2, y1, cx - w2 / 2, y2, cx - w2 / 2 - w2 * 0.035, y2, curb)
      this.trapezoid(cx + w1 / 2, y1, cx + w1 / 2 + w1 * 0.035, y1, cx + w2 / 2 + w2 * 0.035, y2, cx + w2 / 2, y2, curb)
    }

    this.drawLaneLine(t, 1 / 3, "rgba(255,255,255,.78)", 3)
    this.drawLaneLine(t, 2 / 3, "rgba(255,255,255,.78)", 3)
    this.drawLaneLine(t, 1 / 2, "#ffe66d", 6)
    this.drawSpeedLines(t)
  },

  drawLaneLine(t, k, color, width) {
    const ctx = this.ctx
    const topY = this.height * 0.42
    const bottomY = this.height
    const topW = this.width * 0.22
    const bottomW = this.width * 1.16
    const cx = this.width / 2
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.setLineDash(k === 0.5 ? [] : [20, 18])
    ctx.lineDashOffset = -t * 125
    ctx.beginPath()
    ctx.moveTo(cx - topW / 2 + topW * k, topY)
    ctx.lineTo(cx - bottomW / 2 + bottomW * k, bottomY)
    ctx.stroke()
    ctx.restore()
  },

  drawSpeedLines(t) {
    const ctx = this.ctx
    if (!this.game || this.game.speed < 300) return
    ctx.save()
    ctx.strokeStyle = "rgba(255,255,255,.34)"
    ctx.lineWidth = 3
    for (let i = 0; i < 12; i++) {
      const side = i % 2 === 0 ? -1 : 1
      const y = this.height * (0.48 + ((i * 0.077 + t * 1.7) % 0.45))
      const len = 26 + (y / this.height) * 66
      const x = this.width / 2 + side * this.width * (0.28 + (i % 4) * 0.055)
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + side * len, y + len * 0.5)
      ctx.stroke()
    }
    ctx.restore()
  },

  drawSideDecorations(t) {
    const ctx = this.ctx
    const topY = this.height * 0.43
    const bottomY = this.height
    const count = 12
    for (let i = count - 1; i >= 0; i--) {
      const phase = ((i / count + t * 0.12) % 1)
      const depth = Math.pow(phase, 1.75)
      const y = topY + depth * (bottomY - topY)
      const scale = 0.22 + depth * 1.1
      const roadW = this.width * (0.22 + Math.pow(phase, 1.22) * 0.94)
      const side = i % 2 === 0 ? -1 : 1
      const x = this.width / 2 + side * roadW * (0.58 + (i % 3) * 0.08)
      const kind = i % 4
      if (kind === 0) this.drawTree(x, y, 44 * scale)
      else if (kind === 1) this.drawBalloon(x, y - 32 * scale, 28 * scale, i)
      else if (kind === 2) this.drawSign(x, y, 36 * scale)
      else this.drawFlowerBush(x, y, 34 * scale)
    }
    ctx.globalAlpha = 1
  },

  drawTree(x, y, s) {
    const ctx = this.ctx
    ctx.save()
    ctx.fillStyle = "#8b6241"
    this.roundRect(x - s * 0.11, y - s * 0.48, s * 0.22, s * 0.58, s * 0.06)
    ctx.fill()
    const g = ctx.createLinearGradient(x, y - s * 1.25, x, y - s * 0.18)
    g.addColorStop(0, "#7fe08a")
    g.addColorStop(1, "#35aa64")
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y - s * 0.86, s * 0.42, 0, Math.PI * 2)
    ctx.arc(x - s * 0.3, y - s * 0.66, s * 0.34, 0, Math.PI * 2)
    ctx.arc(x + s * 0.34, y - s * 0.63, s * 0.36, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  },

  drawBalloon(x, y, s, seed) {
    const ctx = this.ctx
    const colors = ["#ff6f91", "#ffd95e", "#74d6ff", "#8de36f"]
    ctx.save()
    ctx.strokeStyle = "rgba(65,82,110,.45)"
    ctx.lineWidth = Math.max(1, s * 0.07)
    ctx.beginPath()
    ctx.moveTo(x, y + s * 0.52)
    ctx.lineTo(x, y + s * 1.35)
    ctx.stroke()
    ctx.fillStyle = colors[seed % colors.length]
    ctx.beginPath()
    ctx.ellipse(x, y, s * 0.58, s * 0.72, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = "rgba(255,255,255,.55)"
    ctx.beginPath()
    ctx.arc(x - s * 0.16, y - s * 0.22, s * 0.14, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  },

  drawSign(x, y, s) {
    const ctx = this.ctx
    ctx.save()
    ctx.fillStyle = "#8b6241"
    this.roundRect(x - s * 0.08, y - s * 0.5, s * 0.16, s * 0.62, s * 0.04)
    ctx.fill()
    ctx.fillStyle = "#ffe66d"
    this.roundRect(x - s * 0.48, y - s * 0.95, s * 0.96, s * 0.42, s * 0.1)
    ctx.fill()
    ctx.fillStyle = "#4d6072"
    ctx.font = `${Math.round(s * 0.28)}px sans-serif`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText("GO", x, y - s * 0.74)
    ctx.restore()
  },

  drawFlowerBush(x, y, s) {
    const ctx = this.ctx
    ctx.save()
    ctx.fillStyle = "#43b96a"
    ctx.beginPath()
    ctx.arc(x - s * 0.26, y - s * 0.18, s * 0.28, 0, Math.PI * 2)
    ctx.arc(x, y - s * 0.28, s * 0.34, 0, Math.PI * 2)
    ctx.arc(x + s * 0.28, y - s * 0.16, s * 0.28, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = "#ff8ab3"
    for (let i = 0; i < 3; i++) {
      ctx.beginPath()
      ctx.arc(x + (i - 1) * s * 0.22, y - s * (0.35 + i * 0.04), s * 0.07, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  },

  trapezoid(x1, y1, x2, y2, x3, y3, x4, y4, color) {
    const ctx = this.ctx
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.lineTo(x3, y3)
    ctx.lineTo(x4, y4)
    ctx.closePath()
    ctx.fill()
  },

  drawItems() {
    const g = this.game
    const items = [...g.items].sort((a, b) => a.y - b.y)
    items.forEach((item) => {
      const scale = clamp(item.y / this.height, 0.25, 1.1)
      const x = this.laneX(item.lane, item.y)
      const size = 28 + scale * 36
      if (item.kind === "star") this.drawStar(x, item.y, size, item.spin)
      else if (item.kind === "coin") this.drawCoin(x, item.y, size * 0.8, item.spin)
      else if (item.kind === "heart") this.drawHeart(x, item.y, size * 0.78)
      else this.drawCone(x, item.y, size)
    })
  },

  drawPlayer() {
    const g = this.game
    const y = this.height * 0.76 - g.jumpY
    const x = this.laneX(g.lane, y)
    const blink = g.invincible > 0 && Math.floor(g.time * 14) % 2 === 0
    if (blink) return
    this.drawPet(x, y, this.height * 0.055, g.time)
  },

  drawPet(x, y, s, t) {
    const pet = PETS.find((p) => p.id === this.data.selectedPet) || PETS[0]
    const ctx = this.ctx
    const bob = Math.sin(t * 8) * s * 0.06

    ctx.save()
    ctx.translate(x, y + bob)
    ctx.fillStyle = "rgba(34,42,70,.22)"
    ctx.beginPath()
    ctx.ellipse(0, s * 0.74, s * 1.35, s * 0.34, 0, 0, Math.PI * 2)
    ctx.fill()

    const car = ctx.createLinearGradient(0, -s, 0, s * 0.6)
    car.addColorStop(0, pet.body)
    car.addColorStop(1, pet.trim)
    ctx.fillStyle = car
    this.roundRect(-s * 1.15, -s * 0.35, s * 2.3, s * 1.0, s * 0.28)
    ctx.fill()
    ctx.fillStyle = "rgba(255,255,255,.72)"
    this.roundRect(-s * 0.58, -s * 0.82, s * 1.16, s * 0.58, s * 0.24)
    ctx.fill()

    ctx.fillStyle = "#2f3348"
    ctx.beginPath()
    ctx.arc(-s * 0.72, s * 0.48, s * 0.28, 0, Math.PI * 2)
    ctx.arc(s * 0.72, s * 0.48, s * 0.28, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = "#fff"
    ctx.beginPath()
    ctx.arc(-s * 0.72, s * 0.48, s * 0.12, 0, Math.PI * 2)
    ctx.arc(s * 0.72, s * 0.48, s * 0.12, 0, Math.PI * 2)
    ctx.fill()

    ctx.font = `${Math.round(s * 0.9)}px sans-serif`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(pet.emoji, 0, -s * 0.72)
    ctx.restore()
  },

  drawStar(x, y, size, rot) {
    const ctx = this.ctx
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rot)
    ctx.fillStyle = "#ffd95e"
    ctx.strokeStyle = "#ff9b4a"
    ctx.lineWidth = 3
    ctx.beginPath()
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? size * 0.5 : size * 0.22
      const a = -Math.PI / 2 + (Math.PI * 2 * i) / 10
      const px = Math.cos(a) * r
      const py = Math.sin(a) * r
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  },

  drawCoin(x, y, size, rot) {
    const ctx = this.ctx
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(Math.max(0.35, Math.abs(Math.cos(rot))), 1)
    ctx.fillStyle = "#ffc44d"
    ctx.strokeStyle = "#f08a24"
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.arc(0, 0, size * 0.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = "#fff2a6"
    ctx.font = `${Math.round(size * 0.42)}px sans-serif`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText("●", 0, 0)
    ctx.restore()
  },

  drawHeart(x, y, size) {
    const ctx = this.ctx
    ctx.save()
    ctx.translate(x, y)
    ctx.fillStyle = "#ff6f91"
    ctx.beginPath()
    ctx.moveTo(0, size * 0.38)
    ctx.bezierCurveTo(-size, -size * 0.25, -size * 0.46, -size, 0, -size * 0.46)
    ctx.bezierCurveTo(size * 0.46, -size, size, -size * 0.25, 0, size * 0.38)
    ctx.fill()
    ctx.restore()
  },

  drawCone(x, y, size) {
    const ctx = this.ctx
    ctx.save()
    ctx.translate(x, y)
    ctx.fillStyle = "#ff7a6d"
    ctx.beginPath()
    ctx.moveTo(0, -size * 0.55)
    ctx.lineTo(size * 0.42, size * 0.45)
    ctx.lineTo(-size * 0.42, size * 0.45)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = "#fff"
    ctx.fillRect(-size * 0.26, -size * 0.05, size * 0.52, size * 0.12)
    ctx.fillStyle = "#5a6476"
    this.roundRect(-size * 0.55, size * 0.42, size * 1.1, size * 0.18, 5)
    ctx.fill()
    ctx.restore()
  },

  drawParticles() {
    const ctx = this.ctx
    const g = this.game
    g.particles.forEach((p) => {
      ctx.globalAlpha = clamp(p.life / p.maxLife, 0, 1)
      ctx.fillStyle = p.color
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
      ctx.fill()
    })
    ctx.globalAlpha = 1
  },

  drawLives() {
    const ctx = this.ctx
    const g = this.game
    ctx.font = "24px sans-serif"
    ctx.textAlign = "left"
    ctx.textBaseline = "middle"
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = i < g.lives ? 1 : 0.28
      ctx.fillText("❤", 22 + i * 28, this.height * 0.18)
    }
    ctx.globalAlpha = 1
  },

  drawGameMessage() {
    const g = this.game
    if (!g.message || g.messageT <= 0) return
    const ctx = this.ctx
    ctx.save()
    ctx.globalAlpha = clamp(g.messageT, 0, 1)
    ctx.fillStyle = "rgba(255,255,255,.84)"
    this.roundRect(this.width / 2 - 92, this.height * 0.3 - 28, 184, 56, 28)
    ctx.fill()
    ctx.fillStyle = "#354660"
    ctx.font = "bold 24px sans-serif"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(g.message, this.width / 2, this.height * 0.3)
    ctx.restore()
  },

  roundRect(x, y, w, h, r) {
    const ctx = this.ctx
    const rr = Math.min(r, w / 2, h / 2)
    ctx.beginPath()
    ctx.moveTo(x + rr, y)
    ctx.lineTo(x + w - rr, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
    ctx.lineTo(x + w, y + h - rr)
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
    ctx.lineTo(x + rr, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
    ctx.lineTo(x, y + rr)
    ctx.quadraticCurveTo(x, y, x + rr, y)
    ctx.closePath()
  }
})
