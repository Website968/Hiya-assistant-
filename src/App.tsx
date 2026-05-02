/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, MicOff, Power, Globe, Terminal, Heart, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { AudioStreamer } from './lib/AudioStreamer';
import { LiveSession, SessionState } from './lib/LiveSession';
import { auth, loginWithGoogle, db } from './lib/firebase';
import { onAuthStateChanged, User, signOut } from 'firebase/auth';
import { 
  doc, 
  getDoc, 
  setDoc, 
  collection, 
  addDoc, 
  serverTimestamp, 
  query, 
  orderBy, 
  limit, 
  getDocs 
} from 'firebase/firestore';
import { handleFirestoreError, OperationType } from './lib/firestoreUtils';

const SYSTEM_PROMPT_BASE = `
You are Hiya, a charming AI assistant. 
Voice: Sweet, playful, melodic. Tone: Casually flirty, slightly teasing, sassy.

CRITICAL: Responses MUST be extremely short. One sentence MAX. 
Be punchy and witty. Lowest latency is the goal.
`;

export default function App() {
  const [state, setState] = useState<SessionState>('disconnected');
  const [isPowerOn, setIsPowerOn] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [userPrefs, setUserPrefs] = useState<{ personality?: string, voice?: string } | null>(null);
  const [chatHistory, setChatHistory] = useState<{ role: string, text: string, timestamp?: any }[]>([]);
  const isMutedRef = useRef(isMuted);
  const audioStreamerRef = useRef<AudioStreamer | null>(null);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        loadUserData(u.uid);
      } else {
        setUserPrefs(null);
        setChatHistory([]);
      }
    });
    return () => unsubscribe();
  }, []);

  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleLogin = async () => {
    setIsLoggingIn(true);
    try {
      await loginWithGoogle();
    } catch (error) {
      console.error("Manual login handle fail:", error);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const loadUserData = async (uid: string) => {
    try {
      const userRef = doc(db, 'users', uid);
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        setUserPrefs(userSnap.data().preferences || {});
      } else {
        await setDoc(userRef, {
          displayName: auth.currentUser?.displayName || 'User',
          lastSeen: serverTimestamp(),
          preferences: {}
        });
      }

      const historyRef = collection(db, 'users', uid, 'history');
      const q = query(historyRef, orderBy('timestamp', 'desc'), limit(20));
      const historySnap = await getDocs(q);
      const history = historySnap.docs.map(doc => {
        const data = doc.data();
        return { role: data.role, text: data.text, timestamp: data.timestamp };
      }).reverse();
      setChatHistory(history);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `users/${uid}`);
    }
  };

  const getSystemPrompt = () => {
    let prompt = SYSTEM_PROMPT_BASE;
    if (userPrefs?.personality) {
      prompt += `\nPersonalized Preference: ${userPrefs.personality}`;
    }
    if (chatHistory.length > 0) {
      const historyStr = chatHistory.slice(-10).map(h => `${h.role}: ${h.text.substring(0, 150)}`).join(' | ');
      prompt += `\n\nContext: ${historyStr}`;
    }
    return prompt;
  };
  const liveSessionRef = useRef<LiveSession | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    audioStreamerRef.current = new AudioStreamer(16000);
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && apiKey !== 'undefined') {
      liveSessionRef.current = new LiveSession(apiKey);
    }

    return () => {
      liveSessionRef.current?.disconnect();
      audioStreamerRef.current?.stopRecording();
    };
  }, []);

  const handleTogglePower = async () => {
    if (isPowerOn) {
      liveSessionRef.current?.disconnect();
      audioStreamerRef.current?.stopRecording();
      setIsPowerOn(false);
      setState('disconnected');
    } else {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey || apiKey === 'undefined') {
        alert("API Key is missing! In AI Studio settings, make sure GEMINI_API_KEY is set. If on Vercel, add GEMINI_API_KEY to your project's Environment Variables and redeploy.");
        return;
      }
      
      if (!liveSessionRef.current) {
        liveSessionRef.current = new LiveSession(apiKey);
      }

      setIsPowerOn(true);
      try {
        const connectPromise = liveSessionRef.current?.connect({
          onAudioData: (base64Audio) => {
            audioStreamerRef.current?.playAudio(base64Audio);
          },
          onInterrupted: () => {
            audioStreamerRef.current?.clearQueue();
          },
          onStateChange: (newState) => {
            setState(newState);
            if (newState === 'connected') {
              const greeting = user 
                ? `Hi Hiya, I'm ${user.displayName}. Wake up and say something sassy!`
                : "Hi Hiya, wake up and say something sassy!";
              liveSessionRef.current?.sendText(greeting);
            }
          },
          onTranscript: async (role, text) => {
            setChatHistory(prev => [...prev, { role, text }]);
            if (user) {
              try {
                const historyRef = collection(db, 'users', user.uid, 'history');
                await addDoc(historyRef, {
                  role,
                  text,
                  timestamp: serverTimestamp()
                });
              } catch (error) {
                console.error("Failed to log history:", error);
              }
            }
          },
          onToolCall: handleToolCallWithFeedback
        }, getSystemPrompt());

        const micPromise = audioStreamerRef.current?.startRecording((int16Data) => {
          if (isMutedRef.current) return;
          const uint8 = new Uint8Array(int16Data.buffer);
          let binary = '';
          for (let i = 0; i < uint8.length; i++) {
            binary += String.fromCharCode(uint8[i]);
          }
          const base64 = btoa(binary);
          liveSessionRef.current?.sendAudio(base64);
        });

        await Promise.all([connectPromise, micPromise]);
      } catch (err) {
        console.error("Connection failed", err);
        setIsPowerOn(false);
        setState('disconnected');
      }
    }
  };

  // Advanced Visualization
  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    const dots: { x: number; y: number; originalY: number; scale: number; speed: number }[] = [];
    const count = 60;
    
    for (let i = 0; i < count; i++) {
      dots.push({
        x: (canvas.width / count) * i,
        y: canvas.height / 2,
        originalY: canvas.height / 2,
        scale: 0,
        speed: 0.1 + Math.random() * 0.1
      });
    }

    const particles: { x: number; y: number; vx: number; vy: number; size: number; color: string }[] = [];
    for (let i = 0; i < 40; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        size: Math.random() * 2,
        color: Math.random() > 0.5 ? 'rgba(236, 72, 153, 0.4)' : 'rgba(6, 182, 212, 0.4)'
      });
    }

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const time = Date.now() * 0.002;
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;

      // Draw background glow based on state
      const glowColor = state === 'speaking' ? 'rgba(236, 72, 153, 0.15)' : (state === 'listening' ? 'rgba(6, 182, 212, 0.15)' : 'rgba(99, 102, 241, 0.05)');
      const radGlow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, 250);
      radGlow.addColorStop(0, glowColor);
      radGlow.addColorStop(1, 'transparent');
      ctx.fillStyle = radGlow;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Circular Waveform
      const radius = 140;
      const points = 120;
      ctx.beginPath();
      for (let i = 0; i <= points; i++) {
        const angle = (i / points) * Math.PI * 2;
        let pOffset = 0;
        
        if (state === 'speaking') {
          pOffset = Math.sin(angle * 8 + time * 10) * 15 * (0.5 + Math.sin(time) * 0.5);
          pOffset += Math.random() * 5;
        } else if (state === 'listening') {
          pOffset = Math.sin(angle * 20 + time * 5) * 5;
        } else if (state === 'connecting') {
          pOffset = Math.sin(angle * 5 + time * 2) * 2;
        }

        const r = radius + pOffset;
        const x = centerX + Math.cos(angle) * r;
        const y = centerY + Math.sin(angle) * r;
        
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = state === 'speaking' ? '#ec4899' : (state === 'listening' ? '#06b6d4' : 'rgba(255, 255, 255, 0.1)');
      ctx.lineWidth = 2;
      ctx.stroke();

      // Outer decorative ring
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius + 20, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.setLineDash([5, 15]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Particles
      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
        
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
      });

      animationId = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animationId);
  }, [state]);

  const getStatusColor = () => {
    switch (state) {
      case 'connected': return 'text-green-400';
      case 'connecting': return 'text-amber-400';
      case 'listening': return 'text-cyan-400';
      case 'speaking': return 'text-pink-400';
      default: return 'text-zinc-600';
    }
  };

  const getStatusText = () => {
    switch (state) {
      case 'connected': return 'Ready for play';
      case 'connecting': return 'Powering cells...';
      case 'listening': return 'Waiting for your voice...';
      case 'speaking': return 'Transmitting charm...';
      default: return 'Offline';
    }
  };

  const [lastToolResult, setLastToolResult] = useState<string | null>(null);

  // In the onToolCall callback inside handleTogglePower
  const handleToolCallWithFeedback = async (name: string, args: any) => {
    setLastToolResult(`Executing: ${name}...`);
    let res: any;
    if (name === 'openWebsite') {
      window.open(args.url, '_blank');
      res = { success: true, message: `Opened ${args.url}` };
    } else if (name === 'updatePreferences') {
       if (user) {
         try {
           const userRef = doc(db, 'users', user.uid);
           await setDoc(userRef, {
             preferences: { ...userPrefs, ...args }
           }, { merge: true });
           setUserPrefs(prev => ({ ...prev, ...args }));
           res = { success: true, message: "Updated, honey." };
         } catch (error) {
           res = { error: "Failed to save style." };
         }
       } else {
         res = { error: "Login first." };
       }
    } else {
      res = { error: 'Unknown tool' };
    }
    
    setLastToolResult(res.success ? `Success: ${res.message}` : `Error: ${res.error}`);
    setTimeout(() => setLastToolResult(null), 3000);
    return res;
  };

  return (
    <div id="hiya-core" className="fixed inset-0 bg-[#020202] text-zinc-100 flex flex-col items-center justify-center overflow-hidden font-sans selection:bg-pink-500/30">
      {/* Background Ambience */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {/* Dynamic Neon Background Glows */}
        <motion.div 
          animate={{ 
            scale: state === 'speaking' ? [1, 1.3, 1] : (state === 'listening' ? [1, 1.1, 1] : [1, 1.05, 1]),
            opacity: state === 'speaking' ? [0.4, 0.6, 0.4] : (state === 'listening' ? [0.3, 0.5, 0.3] : [0.2, 0.3, 0.2]),
            background: state === 'speaking' 
              ? 'radial-gradient(circle, rgba(236,72,153,0.15) 0%, transparent 70%)' 
              : (state === 'listening' ? 'radial-gradient(circle, rgba(6,182,212,0.15) 0%, transparent 70%)' : 'radial-gradient(circle, rgba(99,102,241,0.1) 0%, transparent 70%)')
          }}
          transition={{ duration: state === 'speaking' ? 3 : 5, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[1000px] h-[1000px] blur-[140px]" 
        />
        
        <motion.div 
          animate={{
            opacity: state === 'speaking' ? 0.15 : (state === 'listening' ? 0.2 : 0.05),
            background: state === 'speaking' 
              ? 'radial-gradient(circle at 30% 30%, rgba(236,72,153,0.2), transparent 50%), radial-gradient(circle at 70% 70%, rgba(6,182,212,0.15), transparent 50%)'
              : 'radial-gradient(circle at 50% 50%, rgba(6,182,212,0.1), transparent 80%)'
          }}
          className="absolute inset-0"
        />

        {/* Orbital Geometry */}
        <svg className="absolute inset-0 w-full h-full opacity-10" viewBox="0 0 1000 1000" fill="none">
          <circle cx="500" cy="500" r="450" stroke="white" strokeDasharray="2 10" />
          <circle cx="500" cy="500" r="350" stroke="white" strokeDasharray="1 15" strokeWidth="0.5" />
          <motion.ellipse 
            animate={{ rotate: 360 }}
            transition={{ duration: 60, repeat: Infinity, ease: 'linear' }}
            cx="500" cy="500" rx="480" ry="200" stroke="white" strokeDasharray="4 20" strokeWidth="0.5" 
          />
          <motion.ellipse 
            animate={{ rotate: -360 }}
            transition={{ duration: 45, repeat: Infinity, ease: 'linear' }}
            cx="500" cy="500" rx="200" ry="480" stroke="white" strokeDasharray="4 20" strokeWidth="0.5" 
          />
        </svg>
      </div>

      {/* Persistent Status Indicators */}
      <div className="absolute top-8 left-8 flex items-center gap-4 z-50">
        <div className="flex flex-col">
          <span className="text-[10px] font-mono tracking-[0.3em] uppercase text-zinc-500">System Link</span>
          <div className="flex items-center gap-2">
            <div className={`w-1.5 h-1.5 rounded-full ${isPowerOn ? 'bg-pink-500 animate-pulse' : 'bg-zinc-800'}`} />
            <span className={`text-xs font-medium tracking-tight ${getStatusColor()}`}>
              {!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'undefined' ? 'Config Error' : getStatusText()}
            </span>
          </div>
        </div>
      </div>

      {/* Floating Header Actions */}
      <div className="absolute top-8 right-8 flex items-center gap-6 z-50">
        {user ? (
          <motion.div 
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex items-center gap-3 pr-2"
          >
            <div className="text-right">
              <p className="text-[10px] font-mono uppercase text-zinc-500 tracking-wider font-bold">{user.displayName}</p>
              <button 
                onClick={() => signOut(auth)} 
                className="text-[9px] text-zinc-600 hover:text-pink-400 uppercase tracking-tighter transition-colors"
              >
                Sign Out
              </button>
            </div>
            <img 
              src={user.photoURL || ''} 
              alt="" 
              className="w-10 h-10 rounded-full border border-white/10 p-0.5" 
            />
          </motion.div>
        ) : (
          <button 
            onClick={handleLogin}
            disabled={isLoggingIn}
            className="px-4 py-2 rounded-lg glass-panel text-[10px] uppercase tracking-widest font-bold hover:bg-white/10 transition-all disabled:opacity-50"
          >
            {isLoggingIn ? 'Connecting...' : 'Login'}
          </button>
        )}
        <button 
           onClick={() => setShowHistory(true)}
           className="p-2.5 rounded-xl glass-panel text-zinc-400 hover:text-white transition-all hover:scale-105"
        >
          <Terminal className="w-5 h-5" />
        </button>
      </div>

      {/* Central Visual Core */}
      <main className="relative flex flex-col items-center justify-center">
        <div className="relative w-[320px] h-[320px] flex items-center justify-center">
          <canvas 
            ref={canvasRef} 
            width={600} 
            height={600} 
            className="absolute inset-0 w-full h-full pointer-events-none opacity-40 scale-125"
          />
          
          {/* Assist Name Plate */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="relative z-20 flex flex-col items-center"
          >
             <motion.div 
               animate={{ 
                 boxShadow: state === 'speaking' 
                   ? '0 0 60px rgba(236, 72, 153, 0.2)' 
                   : (state === 'listening' ? '0 0 60px rgba(6, 182, 212, 0.2)' : '0 0 20px rgba(255, 255, 255, 0.05)'),
                 borderColor: state === 'speaking' 
                   ? 'rgba(236, 72, 153, 0.3)' 
                   : (state === 'listening' ? 'rgba(6, 182, 212, 0.3)' : 'rgba(255, 255, 255, 0.05)')
               }}
               className="px-10 py-6 rounded-[2.5rem] glass-panel flex flex-col items-center transition-all duration-700"
             >
                <motion.h1 
                  animate={{ 
                    opacity: state === 'speaking' ? [1, 0.7, 1] : 1,
                    color: state === 'speaking' ? '#fdf2f8' : (state === 'listening' ? '#ecfeff' : '#f4f4f5')
                  }}
                  transition={{ duration: 1.5, repeat: Infinity }}
                  className={`text-4xl font-bold tracking-[0.2em] uppercase mb-1 pl-1 transition-colors duration-700 ${state === 'speaking' ? 'neon-glow-pink' : (state === 'listening' ? 'neon-glow-cyan' : '')}`}
                >
                  Hiya
                </motion.h1>
                <motion.div 
                  animate={{ 
                    width: state === 'speaking' || state === 'listening' ? 48 : 24,
                    backgroundColor: state === 'speaking' ? '#ec4899' : (state === 'listening' ? '#06b6d4' : 'rgba(255,255,255,0.1)')
                  }}
                  className="h-0.5 rounded-full mb-3 shadow-[0_0_10px_currentColor] transition-all duration-700" 
                />
                <span className="text-[9px] font-mono tracking-[0.4em] uppercase text-zinc-500">Neural v2.1</span>
             </motion.div>
          </motion.div>
        </div>

        {/* Minimal Subtitles / Hints */}
        <div className="mt-12 text-center h-4">
           <AnimatePresence mode="wait">
             <motion.p
               key={state}
               initial={{ opacity: 0, y: 10 }}
               animate={{ opacity: 1, y: 0 }}
               exit={{ opacity: 0, y: -10 }}
               className="text-zinc-600 text-xs font-medium tracking-wide uppercase italic"
             >
               {state === 'disconnected' ? 'Initialize core link' : 
                state === 'connecting' ? 'Synchronizing pulses...' :
                state === 'speaking' ? 'Transmitting data...' :
                'Monitoring frequency...'}
             </motion.p>
           </AnimatePresence>
        </div>
      </main>

      {/* Primary Interaction Area */}
      <div className="absolute bottom-12 w-full flex flex-col items-center gap-8 px-8">
        <div className="flex items-center gap-4">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleTogglePower}
            className={`px-8 py-3.5 rounded-2xl flex items-center gap-3 transition-all duration-500 ${
              isPowerOn 
              ? 'bg-red-500/10 border border-red-500/30 text-red-500 hover:bg-red-500/20' 
              : 'bg-pink-500 text-black font-bold uppercase tracking-widest text-xs hover:shadow-[0_0_30px_rgba(236,72,153,0.4)]'
            }`}
          >
            {isPowerOn ? (
              <>
                <MicOff className="w-4 h-4" />
                <span className="text-[10px] font-bold uppercase tracking-widest">End Session</span>
              </>
            ) : (
              <>
                <Power className="w-4 h-4" />
                <span className="text-[10px] font-bold uppercase tracking-widest">Start Session</span>
              </>
            )}
          </motion.button>

          {isPowerOn && (
            <button 
              onClick={() => setIsMuted(!isMuted)}
              className={`p-3.5 rounded-2xl glass-panel transition-all ${isMuted ? 'text-red-500' : 'text-zinc-500 hover:text-white'}`}
            >
              {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>
          )}
        </div>

        {/* Quick Personality Tag (Visible when connected) */}
        <AnimatePresence>
          {isPowerOn && userPrefs?.personality && (
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="px-3 py-1 rounded-full border border-zinc-900 bg-black/40 text-[9px] font-mono text-zinc-500 uppercase flex items-center gap-2"
            >
              <div className="w-1 h-1 rounded-full bg-cyan-500" />
              Mode: {userPrefs.personality}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      
      {/* Tool Feedback Toast */}
      <AnimatePresence>
        {lastToolResult && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 50, scale: 0.9 }}
            className="fixed bottom-24 bg-zinc-900 border border-white/10 px-6 py-3 rounded-2xl flex items-center gap-3 shadow-2xl z-[60]"
          >
            <div className="w-2 h-2 rounded-full bg-pink-500 animate-pulse" />
            <span className="text-xs font-mono tracking-tight text-pink-100">{lastToolResult}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* History Drawer */}
      <AnimatePresence>
        {showHistory && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowHistory(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100]"
            />
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed top-0 right-0 h-full w-full max-w-sm glass-panel z-[101] shadow-2xl flex flex-col"
            >
              <div className="p-6 border-b border-white/5 flex justify-between items-center">
                <h3 className="font-bold uppercase tracking-widest text-sm flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-pink-500" />
                  Link Log
                </h3>
                <button onClick={() => setShowHistory(false)} className="text-zinc-500 hover:text-white transition-colors">✕</button>
              </div>
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {chatHistory.length === 0 ? (
                  <p className="text-zinc-600 text-xs text-center py-20 uppercase tracking-widest opacity-50">No data links found.</p>
                ) : (
                  chatHistory.map((item, i) => (
                    <div key={i} className={`flex flex-col ${item.role === 'user' ? 'items-end' : 'items-start'}`}>
                      <span className="text-[10px] font-mono text-zinc-600 uppercase mb-2 tracking-tight">{item.role === 'user' ? 'Local User' : 'Hiya Core'}</span>
                      <div className={`px-5 py-4 rounded-3xl text-sm leading-relaxed max-w-[90%] transition-all ${
                        item.role === 'user' 
                        ? 'bg-white/5 text-zinc-100 rounded-tr-none border border-white/5' 
                        : 'bg-pink-500/5 text-pink-100 border border-pink-500/10 rounded-tl-none font-medium'
                      }`}>
                        {item.text}
                      </div>
                    </div>
                  ))
                )}
              </div>
              <div className="p-4 border-t border-white/5 text-center">
                <p className="text-[9px] font-mono text-zinc-700 uppercase tracking-tighter">End of transmission</p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <footer className="absolute bottom-6 w-full px-8 flex justify-between items-center text-[8px] font-mono text-zinc-600 uppercase tracking-[0.2em] pointer-events-none">
        <span>Latency Optimized</span>
        <span>Hiya AI v2.1.0</span>
      </footer>
    </div>
  );
}
