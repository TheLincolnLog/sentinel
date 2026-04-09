/**
 * Sentinel Dashboard v5
 * - Receives live scan data from the Chrome extension via BroadcastChannel
 * - Sends browser notifications on high-risk detections
 * - Stores per-feature history with timestamps
 * - Social media content feed: YouTube/IG/TikTok/Discord/Reddit alerts
 * - Manual text analysis via Gemini + heuristic backend
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Shield, AlertTriangle, Zap, Lock, MessageSquare, Activity,
  RefreshCw, Trash2, Scan, Globe, CheckCircle2, XCircle,
  Bell, BellOff, Wifi, WifiOff, Youtube, Instagram,
  Twitter, Hash, Monitor, Eye, TrendingUp, Clock,
  ChevronRight, AlertCircle, ShieldCheck, ShieldAlert,
  BarChart3, Layers, Radio, Filter
} from "lucide-react";
import { GoogleGenAI, Type } from "@google/genai";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

// ── Types ──────────────────────────────────────────────────────────────────────
type Mode = "toxicity" | "misinfo" | "scam";
type Platform = "youtube" | "instagram" | "tiktok" | "discord" | "reddit" | "twitter" | "unknown";
type Severity = "high" | "medium" | "low" | "clean";

interface Flag { phrase: string; type: string; score?: number; }

interface ScanResult {
  id: string;
  timestamp: number;
  source: "extension" | "manual";
  platform?: Platform;
  pageTitle?: string;
  pageUrl?: string;
  contentType?: "short" | "reel" | "post" | "message" | "text" | "unknown";
  toxicity: number;
  manipulation: number;
  misinfo: number;
  scam_score: number;
  ai_score: number;
  flags: Flag[];
  analysis: string;
  primaryConcern: string;
  severity: Severity;
  // Social media specific
  contentTitle?: string;
  contentDescription?: string;
  thumbnailAlt?: string;
}

interface ExtensionMessage {
  type: "SENTINEL_SCAN";
  payload: {
    text: string;
    flags: Flag[];
    toxicity: number;
    manipulation: number;
    misinfo: number;
    scam_score: number;
    ai_score: number;
    platform?: string;
    pageTitle?: string;
    pageUrl?: string;
    contentType?: string;
    contentTitle?: string;
  };
}

interface FeatureStats {
  totalScans: number;
  flaggedScans: number;
  avgScore: number;
  topPhrase: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function getSeverity(tox: number, mis: number, scam: number): Severity {
  const max = Math.max(tox, mis, scam);
  if (max > 0.65) return "high";
  if (max > 0.35) return "medium";
  if (max > 0.1)  return "low";
  return "clean";
}

function getPlatformIcon(platform?: Platform) {
  switch (platform) {
    case "youtube":   return <Youtube className="w-3 h-3 text-red-500" />;
    case "instagram": return <Instagram className="w-3 h-3 text-pink-500" />;
    case "twitter":   return <Twitter className="w-3 h-3 text-sky-500" />;
    case "discord":   return <Hash className="w-3 h-3 text-indigo-500" />;
    case "reddit":    return <Globe className="w-3 h-3 text-orange-500" />;
    case "tiktok":    return <Monitor className="w-3 h-3 text-cyan-500" />;
    default:          return <Globe className="w-3 h-3 text-muted-foreground" />;
  }
}

function getSeverityConfig(severity: Severity) {
  switch (severity) {
    case "high":   return { color: "text-red-600",    bg: "bg-red-50 border-red-100",    dot: "bg-red-500",    label: "HIGH RISK" };
    case "medium": return { color: "text-amber-600",  bg: "bg-amber-50 border-amber-100", dot: "bg-amber-500",  label: "MODERATE" };
    case "low":    return { color: "text-blue-600",   bg: "bg-blue-50 border-blue-100",  dot: "bg-blue-400",   label: "LOW RISK" };
    case "clean":  return { color: "text-green-600",  bg: "bg-green-50 border-green-100", dot: "bg-green-500",  label: "CLEAN" };
  }
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function uid() { return Math.random().toString(36).slice(2, 10); }

function detectPlatform(url?: string): Platform {
  if (!url) return "unknown";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("tiktok.com")) return "tiktok";
  if (url.includes("discord.com")) return "discord";
  if (url.includes("reddit.com")) return "reddit";
  if (url.includes("twitter.com") || url.includes("x.com")) return "twitter";
  return "unknown";
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────
export default function AnalysisDashboard() {
  const [activeTab, setActiveTab]           = useState<string>("live");
  const [activeMode, setActiveMode]         = useState<Mode>("toxicity");
  const [inputText, setInputText]           = useState("");
  const [isAnalyzing, setIsAnalyzing]       = useState(false);
  const [liveResults, setLiveResults]       = useState<ScanResult[]>([]);
  const [manualResults, setManualResults]   = useState<ScanResult[]>([]);
  const [socialAlerts, setSocialAlerts]     = useState<ScanResult[]>([]);
  const [notificationsOn, setNotificationsOn] = useState(true);
  const [extensionConnected, setExtensionConnected] = useState(false);
  const [lastHeartbeat, setLastHeartbeat]   = useState<number | null>(null);
  const [filterSeverity, setFilterSeverity] = useState<Severity | "all">("all");
  const channelRef = useRef<BroadcastChannel | null>(null);
  const notifPermRef = useRef(false);

  const ai = useMemo(() => new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || ""
  }), []);

  // ── Request notification permission ──────────────────────────────────────────
  useEffect(() => {
    if ("Notification" in window && Notification.permission !== "granted") {
      Notification.requestPermission().then(p => {
        notifPermRef.current = p === "granted";
      });
    } else {
      notifPermRef.current = Notification.permission === "granted";
    }
  }, []);

  // ── BroadcastChannel listener (from extension) ────────────────────────────
  useEffect(() => {
    const channel = new BroadcastChannel("sentinel-dashboard");
    channelRef.current = channel;

    channel.onmessage = async (event: MessageEvent<ExtensionMessage>) => {
      if (event.data?.type !== "SENTINEL_SCAN") return;

      const p = event.data.payload;
      setExtensionConnected(true);
      setLastHeartbeat(Date.now());

      const platform = detectPlatform(p.pageUrl) || (p.platform as Platform) || "unknown";
      const severity  = getSeverity(p.toxicity, p.misinfo, p.scam_score);

      // Get Gemini writeup for high/medium detections
      let analysis = "Heuristic scan complete.";
      let primaryConcern = "No significant threats";
      if (severity === "high" || severity === "medium") {
        try {
          const resp = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: `Analyze this content for safety concerns. Content: "${p.text?.slice(0, 400) || p.contentTitle || ""}"\n\nFlags detected: ${p.flags?.map(f => f.phrase).join(", ") || "none"}\n\nWrite a 2-sentence professional analysis and a short (3 words max) primaryConcern label.`,
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  analysis: { type: Type.STRING },
                  primaryConcern: { type: Type.STRING }
                },
                required: ["analysis", "primaryConcern"]
              }
            }
          });
          const d = JSON.parse(resp.text || "{}");
          analysis       = d.analysis       || analysis;
          primaryConcern = d.primaryConcern || primaryConcern;
        } catch { /* keep defaults */ }
      }

      const result: ScanResult = {
        id: uid(),
        timestamp: Date.now(),
        source: "extension",
        platform,
        pageTitle: p.pageTitle,
        pageUrl: p.pageUrl,
        contentType: (p.contentType as ScanResult["contentType"]) || "unknown",
        toxicity: p.toxicity,
        manipulation: p.manipulation,
        misinfo: p.misinfo,
        scam_score: p.scam_score,
        ai_score: p.ai_score,
        flags: p.flags || [],
        analysis,
        primaryConcern,
        severity,
        contentTitle: p.contentTitle,
      };

      setLiveResults(prev => [result, ...prev].slice(0, 50));

      // Social media content alerts
      const socialPlatforms: Platform[] = ["youtube","instagram","tiktok","discord","reddit","twitter"];
      if (socialPlatforms.includes(platform) && severity !== "clean") {
        setSocialAlerts(prev => [result, ...prev].slice(0, 20));
      }

      // Browser notification
      if (notificationsOn && notifPermRef.current && severity === "high") {
        new Notification("⚠️ Sentinel Alert", {
          body: `${result.primaryConcern} detected on ${platform} — ${result.pageTitle?.slice(0,60) || result.pageUrl?.slice(0,60) || "current page"}`,
          icon: "/favicon.ico",
          tag: result.id,
        });
      }
    };

    // Heartbeat listener
    const heartbeatTimer = setInterval(() => {
      if (lastHeartbeat && Date.now() - lastHeartbeat > 15000) {
        setExtensionConnected(false);
      }
    }, 5000);

    return () => {
      channel.close();
      clearInterval(heartbeatTimer);
    };
  }, [notificationsOn, ai, lastHeartbeat]);

  // ── Manual analysis ───────────────────────────────────────────────────────────
  const handleAnalyze = async () => {
    if (!inputText.trim()) return;
    setIsAnalyzing(true);
    try {
      const hResp = await fetch("/api/analyze-heuristics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: inputText }),
      });
      const hData = await hResp.json();

      const aiResp = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: `Analyze this text for ${activeMode} concerns.\nText: "${inputText.slice(0, 500)}"\n\nProvide a 2-sentence professional analysis and a short (3 words max) primaryConcern label.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              analysis: { type: Type.STRING },
              confidence: { type: Type.NUMBER },
              primaryConcern: { type: Type.STRING }
            },
            required: ["analysis", "confidence", "primaryConcern"]
          }
        }
      });
      const aiData = JSON.parse(aiResp.text || "{}");
      const result: ScanResult = {
        id: uid(),
        timestamp: Date.now(),
        source: "manual",
        toxicity: hData.toxicity || 0,
        manipulation: hData.manipulation || 0,
        misinfo: hData.misinfo || 0,
        scam_score: hData.scam_score || 0,
        ai_score: aiData.confidence || 0,
        flags: [],
        analysis: aiData.analysis || "Analysis complete.",
        primaryConcern: aiData.primaryConcern || "Scan Complete",
        severity: getSeverity(hData.toxicity || 0, hData.misinfo || 0, hData.scam_score || 0),
      };
      setManualResults(prev => [result, ...prev].slice(0, 20));
    } catch (e) {
      console.error("Analysis failed:", e);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // ── Stats computation ─────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const all = [...liveResults, ...manualResults];
    const byMode: Record<Mode, FeatureStats> = {
      toxicity: { totalScans: 0, flaggedScans: 0, avgScore: 0, topPhrase: "—" },
      misinfo:  { totalScans: 0, flaggedScans: 0, avgScore: 0, topPhrase: "—" },
      scam:     { totalScans: 0, flaggedScans: 0, avgScore: 0, topPhrase: "—" },
    };
    all.forEach(r => {
      byMode.toxicity.totalScans++;
      byMode.misinfo.totalScans++;
      byMode.scam.totalScans++;
      if (r.toxicity > 0.35)   byMode.toxicity.flaggedScans++;
      if (r.misinfo > 0.35)    byMode.misinfo.flaggedScans++;
      if (r.scam_score > 0.35) byMode.scam.flaggedScans++;
      byMode.toxicity.avgScore += r.toxicity;
      byMode.misinfo.avgScore  += r.misinfo;
      byMode.scam.avgScore     += r.scam_score;
      const toxFlags  = r.flags.filter(f => f.type === "toxicity");
      const misFlags  = r.flags.filter(f => f.type === "misinfo" || f.type === "manipulation");
      const scamFlags = r.flags.filter(f => f.type === "scam" || f.type === "phishing");
      if (toxFlags[0])  byMode.toxicity.topPhrase = toxFlags[0].phrase.slice(0,30);
      if (misFlags[0])  byMode.misinfo.topPhrase  = misFlags[0].phrase.slice(0,30);
      if (scamFlags[0]) byMode.scam.topPhrase     = scamFlags[0].phrase.slice(0,30);
    });
    const n = all.length || 1;
    byMode.toxicity.avgScore = Math.round(byMode.toxicity.avgScore / n * 100);
    byMode.misinfo.avgScore  = Math.round(byMode.misinfo.avgScore  / n * 100);
    byMode.scam.avgScore     = Math.round(byMode.scam.avgScore     / n * 100);
    return byMode;
  }, [liveResults, manualResults]);

  const filteredLive = useMemo(() =>
    filterSeverity === "all"
      ? liveResults
      : liveResults.filter(r => r.severity === filterSeverity),
    [liveResults, filterSeverity]
  );

  const clearAll = useCallback(() => {
    setLiveResults([]); setManualResults([]); setSocialAlerts([]); setInputText("");
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col overflow-hidden">

      {/* ── Header ── */}
      <header className="border-b px-6 h-14 flex items-center justify-between bg-white/90 backdrop-blur-sm z-20 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl border border-primary/20 flex items-center justify-center bg-primary/5">
            <Shield className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight leading-none">Sentinel</h1>
            <p className="text-[9px] text-muted-foreground uppercase tracking-widest">Intelligence Dashboard</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Extension status */}
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[10px] font-medium ${extensionConnected ? "border-green-200 bg-green-50 text-green-700" : "border-muted text-muted-foreground"}`}>
            {extensionConnected
              ? <><Wifi className="w-3 h-3" /> Extension Live</>
              : <><WifiOff className="w-3 h-3" /> No Extension</>
            }
          </div>

          {/* Notification toggle */}
          <div className="flex items-center gap-2">
            {notificationsOn
              ? <Bell className="w-4 h-4 text-primary" />
              : <BellOff className="w-4 h-4 text-muted-foreground" />
            }
            <Switch
              checked={notificationsOn}
              onCheckedChange={setNotificationsOn}
              size="sm"
            />
          </div>

          <Button variant="ghost" size="icon-sm" onClick={clearAll}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">

        {/* ── Sidebar ── */}
        <aside className="w-52 border-r bg-muted/20 shrink-0 hidden lg:flex flex-col p-3 gap-4 overflow-y-auto">
          {/* Mode selector */}
          <div>
            <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-bold mb-2 px-2">Modules</p>
            <div className="space-y-0.5">
              {([
                { id: "toxicity", icon: MessageSquare, label: "Toxicity",       color: "text-red-500" },
                { id: "misinfo",  icon: AlertTriangle, label: "Misinformation",  color: "text-amber-500" },
                { id: "scam",     icon: Lock,          label: "Scam / Malware",  color: "text-orange-500" },
              ] as const).map(m => (
                <button
                  key={m.id}
                  onClick={() => setActiveMode(m.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-xl border transition-all text-xs font-medium flex items-center gap-2.5 ${
                    activeMode === m.id
                      ? "bg-white border-border shadow-sm text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-white/60 hover:text-foreground"
                  }`}
                >
                  <m.icon className={`w-3.5 h-3.5 ${activeMode === m.id ? m.color : ""}`} />
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <Separator className="opacity-40" />

          {/* Live stats per mode */}
          <div>
            <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-bold mb-2 px-2">Stats</p>
            {(["toxicity", "misinfo", "scam"] as Mode[]).map(mode => {
              const s = stats[mode];
              const cfg = { toxicity: { label: "Toxicity", color: "bg-red-500" }, misinfo: { label: "Misinfo", color: "bg-amber-500" }, scam: { label: "Scam", color: "bg-orange-500" } }[mode];
              return (
                <div key={mode} className={`mb-2 p-2.5 rounded-xl border bg-white/50 ${activeMode === mode ? "border-border shadow-sm" : "border-transparent"}`}>
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-[10px] font-semibold text-muted-foreground">{cfg.label}</span>
                    <span className="text-[9px] font-bold text-foreground">{s.avgScore}% avg</span>
                  </div>
                  <div className="h-1 w-full bg-muted rounded-full overflow-hidden mb-1.5">
                    <div className={`h-full ${cfg.color} rounded-full transition-all`} style={{ width: `${s.avgScore}%` }} />
                  </div>
                  <div className="flex justify-between text-[9px] text-muted-foreground">
                    <span>{s.flaggedScans} flagged</span>
                    <span>{s.totalScans} total</span>
                  </div>
                </div>
              );
            })}
          </div>

          <Separator className="opacity-40" />

          {/* Filter */}
          <div>
            <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-bold mb-2 px-2 flex items-center gap-1"><Filter className="w-2.5 h-2.5" /> Filter</p>
            <div className="space-y-0.5">
              {(["all", "high", "medium", "low", "clean"] as const).map(sev => (
                <button
                  key={sev}
                  onClick={() => setFilterSeverity(sev)}
                  className={`w-full text-left px-3 py-1.5 rounded-lg text-[10px] font-medium flex items-center gap-2 transition-all ${
                    filterSeverity === sev ? "bg-white border border-border shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {sev !== "all" && (
                    <span className={`w-1.5 h-1.5 rounded-full ${getSeverityConfig(sev as Severity).dot}`} />
                  )}
                  {sev === "all" ? "All results" : sev.charAt(0).toUpperCase() + sev.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </aside>

        {/* ── Main content ── */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">

            <div className="border-b bg-white/80 px-6 pt-3 shrink-0">
              <TabsList variant="line" className="h-9">
                <TabsTrigger value="live" className="gap-1.5 text-xs">
                  <Radio className="w-3.5 h-3.5" />
                  Live Feed
                  {liveResults.filter(r => r.severity === "high").length > 0 && (
                    <span className="ml-1 h-4 w-4 rounded-full bg-red-500 text-white text-[8px] flex items-center justify-center font-bold">
                      {liveResults.filter(r => r.severity === "high").length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="social" className="gap-1.5 text-xs">
                  <Eye className="w-3.5 h-3.5" />
                  Social Alerts
                  {socialAlerts.length > 0 && (
                    <span className="ml-1 h-4 w-4 rounded-full bg-amber-500 text-white text-[8px] flex items-center justify-center font-bold">
                      {socialAlerts.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="manual" className="gap-1.5 text-xs">
                  <Scan className="w-3.5 h-3.5" />
                  Manual Scan
                </TabsTrigger>
                <TabsTrigger value="analytics" className="gap-1.5 text-xs">
                  <BarChart3 className="w-3.5 h-3.5" />
                  Analytics
                </TabsTrigger>
              </TabsList>
            </div>

            {/* ══ LIVE FEED TAB ══ */}
            <TabsContent value="live" className="flex-1 overflow-hidden flex flex-col">
              <ScrollArea className="flex-1">
                <div className="p-6 space-y-4">

                  {/* Status banner */}
                  <div className={`p-4 rounded-2xl border flex items-center gap-4 ${extensionConnected ? "bg-green-50 border-green-100" : "bg-muted/40 border-dashed"}`}>
                    <div className={`w-2 h-2 rounded-full ${extensionConnected ? "bg-green-500 animate-pulse" : "bg-muted-foreground/30"}`} />
                    <div className="flex-1">
                      <p className="text-xs font-semibold">{extensionConnected ? "Extension connected — receiving live scan data" : "Waiting for Sentinel extension"}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {extensionConnected
                          ? `Last update: ${lastHeartbeat ? formatTime(lastHeartbeat) : "—"} · ${liveResults.length} scans received`
                          : "Install and activate the Sentinel Chrome extension to see live data here"
                        }
                      </p>
                    </div>
                    {extensionConnected && (
                      <Badge variant="secondary" className="text-[9px]">{liveResults.length} scans</Badge>
                    )}
                  </div>

                  {/* Results */}
                  {filteredLive.length === 0 ? (
                    <div className="py-20 text-center border border-dashed rounded-2xl">
                      <ShieldCheck className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
                      <p className="text-sm text-muted-foreground font-medium">No scan results yet</p>
                      <p className="text-[11px] text-muted-foreground/60 mt-1">Browse with the extension active to start seeing results</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {filteredLive.map(result => (
                        <ScanResultCard key={result.id} result={result} />
                      ))}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </TabsContent>

            {/* ══ SOCIAL ALERTS TAB ══ */}
            <TabsContent value="social" className="flex-1 overflow-hidden flex flex-col">
              <ScrollArea className="flex-1">
                <div className="p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold flex items-center gap-2">
                      <Eye className="w-4 h-4 text-primary" />
                      Social Media Content Alerts
                    </h2>
                    <p className="text-[10px] text-muted-foreground">YouTube Shorts · IG Reels · TikTok · Discord · Reddit</p>
                  </div>

                  {/* Platform breakdown */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {([
                      { platform: "youtube" as Platform,   label: "YouTube",   icon: Youtube,   color: "text-red-500",    bg: "bg-red-50" },
                      { platform: "instagram" as Platform, label: "Instagram", icon: Instagram, color: "text-pink-500",   bg: "bg-pink-50" },
                      { platform: "tiktok" as Platform,    label: "TikTok",    icon: Monitor,   color: "text-cyan-500",   bg: "bg-cyan-50" },
                      { platform: "discord" as Platform,   label: "Discord",   icon: Hash,      color: "text-indigo-500", bg: "bg-indigo-50" },
                      { platform: "reddit" as Platform,    label: "Reddit",    icon: Globe,     color: "text-orange-500", bg: "bg-orange-50" },
                      { platform: "twitter" as Platform,   label: "X/Twitter", icon: Twitter,   color: "text-sky-500",    bg: "bg-sky-50" },
                    ]).map(p => {
                      const count = socialAlerts.filter(a => a.platform === p.platform).length;
                      const flagged = socialAlerts.filter(a => a.platform === p.platform && a.severity !== "clean").length;
                      return (
                        <div key={p.platform} className={`p-3 rounded-xl border bg-white flex items-center gap-3 shadow-sm ${count > 0 ? "shadow-black/5" : "opacity-50"}`}>
                          <div className={`w-7 h-7 rounded-lg ${p.bg} flex items-center justify-center`}>
                            <p.icon className={`w-3.5 h-3.5 ${p.color}`} />
                          </div>
                          <div>
                            <p className="text-[11px] font-semibold">{p.label}</p>
                            <p className="text-[9px] text-muted-foreground">{flagged} flagged / {count} scanned</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <Separator className="opacity-40" />

                  {socialAlerts.length === 0 ? (
                    <div className="py-16 text-center border border-dashed rounded-2xl">
                      <Eye className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
                      <p className="text-sm text-muted-foreground font-medium">No social media alerts yet</p>
                      <p className="text-[11px] text-muted-foreground/60 mt-1">Browse YouTube Shorts, Instagram Reels, TikTok, Discord or Reddit with the extension active</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {socialAlerts.map(result => (
                        <SocialAlertCard key={result.id} result={result} />
                      ))}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </TabsContent>

            {/* ══ MANUAL SCAN TAB ══ */}
            <TabsContent value="manual" className="flex-1 overflow-hidden flex flex-col">
              <ScrollArea className="flex-1">
                <div className="p-6 space-y-6 max-w-3xl mx-auto w-full">

                  {/* Mode picker */}
                  <div className="flex gap-2">
                    {([
                      { id: "toxicity", label: "Toxicity",      color: "border-red-200 bg-red-50 text-red-700" },
                      { id: "misinfo",  label: "Misinfo",        color: "border-amber-200 bg-amber-50 text-amber-700" },
                      { id: "scam",     label: "Scam / Malware", color: "border-orange-200 bg-orange-50 text-orange-700" },
                    ] as const).map(m => (
                      <button
                        key={m.id}
                        onClick={() => setActiveMode(m.id)}
                        className={`px-4 py-2 rounded-xl border text-xs font-semibold transition-all ${activeMode === m.id ? m.color : "border-border text-muted-foreground hover:bg-muted/30"}`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>

                  {/* Input */}
                  <div className="relative">
                    <textarea
                      value={inputText}
                      onChange={e => setInputText(e.target.value)}
                      placeholder="Paste any text, social media post, Discord message, email, or URL here to analyze..."
                      className="w-full h-44 bg-white border border-border rounded-2xl p-5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30 transition-all resize-none shadow-sm"
                    />
                    <div className="absolute bottom-4 right-4 flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setInputText("")} className="text-muted-foreground hover:text-red-600 hover:bg-red-50 text-xs">
                        <Trash2 className="w-3.5 h-3.5 mr-1.5" />Clear
                      </Button>
                      <Button onClick={handleAnalyze} disabled={isAnalyzing || !inputText.trim()} className="h-8 px-5 text-xs font-semibold">
                        {isAnalyzing ? <><RefreshCw className="w-3 h-3 mr-1.5 animate-spin" />Analyzing…</> : <><Scan className="w-3 h-3 mr-1.5" />Run Analysis</>}
                      </Button>
                    </div>
                  </div>

                  {/* Results */}
                  <AnimatePresence mode="wait">
                    {manualResults.length > 0 && (
                      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-4">
                        {manualResults.map((result, i) => (
                          <motion.div key={result.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
                            <DetailedResultCard result={result} />
                          </motion.div>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </ScrollArea>
            </TabsContent>

            {/* ══ ANALYTICS TAB ══ */}
            <TabsContent value="analytics" className="flex-1 overflow-hidden flex flex-col">
              <ScrollArea className="flex-1">
                <div className="p-6 space-y-6">
                  <h2 className="text-sm font-semibold flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-primary" /> Analytics Overview
                  </h2>

                  {/* Summary cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {[
                      { label: "Total Scans",    value: liveResults.length + manualResults.length, icon: Layers,      color: "text-primary" },
                      { label: "High Risk",      value: [...liveResults,...manualResults].filter(r => r.severity === "high").length, icon: ShieldAlert, color: "text-red-500" },
                      { label: "Social Alerts",  value: socialAlerts.length, icon: Eye,            color: "text-amber-500" },
                      { label: "Clean",          value: [...liveResults,...manualResults].filter(r => r.severity === "clean").length, icon: ShieldCheck, color: "text-green-500" },
                    ].map(s => (
                      <Card key={s.label} size="sm" className="border-none shadow-sm">
                        <CardContent className="pt-4">
                          <div className="flex items-center gap-2 mb-1">
                            <s.icon className={`w-4 h-4 ${s.color}`} />
                            <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">{s.label}</span>
                          </div>
                          <p className="text-2xl font-bold">{s.value}</p>
                        </CardContent>
                      </Card>
                    ))}
                  </div>

                  {/* Per-mode breakdown */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {(["toxicity", "misinfo", "scam"] as Mode[]).map(mode => {
                      const s = stats[mode];
                      const cfg = {
                        toxicity: { label: "Toxicity",      bar: "bg-red-500",    icon: MessageSquare },
                        misinfo:  { label: "Misinformation", bar: "bg-amber-500",  icon: AlertTriangle },
                        scam:     { label: "Scam / Malware", bar: "bg-orange-500", icon: Lock },
                      }[mode];
                      return (
                        <Card key={mode} size="sm" className="border-none shadow-sm">
                          <CardHeader className="pb-2">
                            <CardTitle className="flex items-center gap-2 text-xs">
                              <cfg.icon className="w-3.5 h-3.5" />
                              {cfg.label}
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            <div className="space-y-1">
                              <div className="flex justify-between text-[10px]">
                                <span className="text-muted-foreground">Avg score</span>
                                <span className="font-bold">{s.avgScore}%</span>
                              </div>
                              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                <div className={`h-full ${cfg.bar}`} style={{ width: `${s.avgScore}%` }} />
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-[10px]">
                              <div className="p-2 bg-muted/40 rounded-lg">
                                <p className="text-muted-foreground">Total</p>
                                <p className="font-bold text-sm">{s.totalScans}</p>
                              </div>
                              <div className="p-2 bg-muted/40 rounded-lg">
                                <p className="text-muted-foreground">Flagged</p>
                                <p className="font-bold text-sm">{s.flaggedScans}</p>
                              </div>
                            </div>
                            {s.topPhrase !== "—" && (
                              <div className="p-2 bg-muted/30 rounded-lg">
                                <p className="text-[9px] text-muted-foreground mb-0.5">Top phrase</p>
                                <p className="text-[10px] font-medium italic truncate">"{s.topPhrase}"</p>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>

                  {/* Timeline */}
                  <Card size="sm" className="border-none shadow-sm">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5" /> Recent Activity Timeline
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        {[...liveResults, ...manualResults]
                          .sort((a, b) => b.timestamp - a.timestamp)
                          .slice(0, 8)
                          .map(r => {
                            const cfg = getSeverityConfig(r.severity);
                            return (
                              <div key={r.id} className="flex items-center gap-3 py-1.5">
                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} />
                                <span className="text-[10px] text-muted-foreground w-12 shrink-0">{formatTime(r.timestamp)}</span>
                                <span className="text-[10px] flex-1 truncate">{r.contentTitle || r.pageTitle || r.pageUrl || "Manual scan"}</span>
                                <div className="flex items-center gap-1 shrink-0">
                                  {getPlatformIcon(r.platform)}
                                  <Badge variant="outline" className={`text-[8px] px-1.5 py-0 h-4 ${cfg.bg} ${cfg.color} border-0`}>{cfg.label}</Badge>
                                </div>
                              </div>
                            );
                          })}
                        {liveResults.length === 0 && manualResults.length === 0 && (
                          <p className="text-[11px] text-muted-foreground text-center py-6">No activity yet</p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </ScrollArea>
            </TabsContent>

          </Tabs>
        </main>
      </div>

      {/* Footer */}
      <footer className="h-9 border-t bg-white shrink-0 flex items-center px-6 justify-between text-[9px] text-muted-foreground font-medium">
        <div className="flex gap-4">
          <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-green-500" />API Connected</span>
          <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-primary/60" />Gemini Active</span>
        </div>
        <span>© 2026 Sentinel Intelligence · v5.0</span>
      </footer>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ScanResultCard({ result }: { result: ScanResult }) {
  const cfg = getSeverityConfig(result.severity);
  const [expanded, setExpanded] = useState(false);

  return (
    <motion.div initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
      className={`p-4 rounded-2xl border bg-white shadow-sm shadow-black/5 cursor-pointer transition-all hover:shadow-md ${result.severity === "high" ? "border-red-100" : "border-border"}`}
      onClick={() => setExpanded(e => !e)}
    >
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${cfg.dot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5">
              {getPlatformIcon(result.platform)}
              <span className="text-[10px] font-medium text-muted-foreground capitalize">{result.platform || "web"}</span>
            </div>
            <Badge variant="outline" className={`text-[8px] h-4 px-1.5 ${cfg.bg} ${cfg.color} border-0`}>{cfg.label}</Badge>
            {result.contentType && result.contentType !== "unknown" && (
              <Badge variant="outline" className="text-[8px] h-4 px-1.5 capitalize">{result.contentType}</Badge>
            )}
            <span className="text-[9px] text-muted-foreground ml-auto">{formatTime(result.timestamp)}</span>
          </div>

          <p className="text-xs font-medium mt-1.5 truncate">{result.contentTitle || result.pageTitle || result.pageUrl || "—"}</p>

          {/* Mini metrics */}
          <div className="flex gap-3 mt-2">
            {[
              { label: "Tox", val: result.toxicity,   color: "bg-red-500" },
              { label: "Mis", val: result.misinfo,     color: "bg-amber-500" },
              { label: "Scam",val: result.scam_score,  color: "bg-orange-500" },
            ].map(m => (
              <div key={m.label} className="flex items-center gap-1.5">
                <span className="text-[9px] text-muted-foreground">{m.label}</span>
                <div className="w-14 h-1 bg-muted rounded-full overflow-hidden">
                  <div className={`h-full ${m.color}`} style={{ width: `${m.val * 100}%` }} />
                </div>
                <span className="text-[9px] font-medium">{Math.round(m.val * 100)}%</span>
              </div>
            ))}
          </div>
        </div>
        <ChevronRight className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mt-3 pt-3 border-t space-y-2">
              <p className="text-[11px] text-foreground/80 leading-relaxed">{result.analysis}</p>
              {result.flags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {result.flags.slice(0, 5).map((f, i) => (
                    <span key={i} className="text-[9px] px-2 py-0.5 bg-muted rounded-full font-medium">"{f.phrase.slice(0, 30)}"</span>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function SocialAlertCard({ result }: { result: ScanResult }) {
  const cfg = getSeverityConfig(result.severity);
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
      className={`p-4 rounded-2xl border bg-white shadow-sm ${cfg.bg}`}
    >
      <div className="flex items-start gap-3">
        <div className={`w-8 h-8 rounded-xl flex items-center justify-center bg-white shadow-sm shrink-0`}>
          {getPlatformIcon(result.platform)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={`text-[8px] h-4 px-1.5 ${cfg.bg} ${cfg.color} border-0 font-bold`}>{cfg.label}</Badge>
            <span className="text-[9px] text-muted-foreground capitalize">{result.platform}</span>
            {result.contentType && <span className="text-[9px] text-muted-foreground capitalize">· {result.contentType}</span>}
            <span className="text-[9px] text-muted-foreground ml-auto">{formatTime(result.timestamp)}</span>
          </div>
          <p className="text-xs font-semibold mt-1">{result.contentTitle || result.pageTitle || "Content detected"}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{result.analysis}</p>
          {result.flags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {result.flags.slice(0, 3).map((f, i) => (
                <span key={i} className="text-[9px] px-2 py-0.5 bg-white/80 rounded-full border border-border font-medium">
                  {f.type}: "{f.phrase.slice(0, 25)}"
                </span>
              ))}
            </div>
          )}
        </div>
        {result.severity === "high"
          ? <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
          : <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
        }
      </div>
    </motion.div>
  );
}

function DetailedResultCard({ result }: { result: ScanResult }) {
  const cfg = getSeverityConfig(result.severity);
  return (
    <Card className="border-none shadow-lg shadow-primary/5 bg-white overflow-hidden">
      <div className={`h-1 w-full ${result.severity === "high" ? "bg-red-500" : result.severity === "medium" ? "bg-amber-500" : result.severity === "low" ? "bg-blue-400" : "bg-green-500"}`} />
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Analysis Result</CardTitle>
          <Badge variant="outline" className={`${cfg.bg} ${cfg.color} border-0 text-[9px] font-bold`}>{result.primaryConcern}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm font-medium leading-relaxed text-foreground/90">{result.analysis}</p>
        <div className="space-y-2.5">
          {[
            { label: "Toxicity",    val: result.toxicity,    color: "bg-red-500" },
            { label: "Misinfo",     val: result.misinfo,     color: "bg-amber-500" },
            { label: "Manipulation",val: result.manipulation,color: "bg-blue-500" },
            { label: "Scam Risk",   val: result.scam_score,  color: "bg-orange-500" },
            { label: "AI Likelihood",val: result.ai_score,   color: "bg-purple-500" },
          ].map(m => (
            <div key={m.label} className="space-y-1">
              <div className="flex justify-between text-[10px] font-semibold">
                <span className="text-muted-foreground">{m.label}</span>
                <span>{Math.round(m.val * 100)}%</span>
              </div>
              <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                <motion.div initial={{ width: 0 }} animate={{ width: `${m.val * 100}%` }} className={`h-full ${m.color}`} />
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between pt-1">
          <span className="text-[9px] text-muted-foreground">{formatTime(result.timestamp)}</span>
          <Badge variant="outline" className={`text-[8px] ${cfg.bg} ${cfg.color} border-0`}>{cfg.label}</Badge>
        </div>
      </CardContent>
    </Card>
  );
}
