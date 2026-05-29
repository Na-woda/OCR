import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity, TextInput,
  Animated, Vibration, FlatList, Share, Alert,
  Easing, StatusBar, Platform, ActivityIndicator,
} from 'react-native';
import { CameraView, useCameraPermissions, CameraType } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

// ─── Types ────────────────────────────────────────────────────────────────────
interface CartItem {
  id: string;
  label: string;
  price: number;
  rawText: string;
  capturedAt: Date;
  quantity: number;
}

type Tab = 'scanner' | 'cart';
type BudgetAlert = 'none' | 'warning' | 'danger' | 'over';
type ScanState = 'idle' | 'capturing' | 'processing' | 'done' | 'error';

// ─── OCR via Google Cloud Vision ─────────────────────────────────────────────
// Set your Google Cloud Vision API key here:
const VISION_API_KEY = 'bcfe7168d09b87ac9c61e7316508b6f423d6bb70';

const runOCR = async (base64Image: string): Promise<string> => {
  const body = {
    requests: [{
      image: { content: base64Image }, 
      features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
    }],
  };
  const res = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${VISION_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const json = await res.json();
  return json.responses?.[0]?.fullTextAnnotation?.text ?? '';
};

// ─── Price extraction from raw OCR text ──────────────────────────────────────
// Looks for patterns like:  Rs. 450   Rs.450   450.00   1,250   රු 450
const extractPrice = (text: string): { price: number; label: string } | null => {
  // Normalise
  const clean = text.replace(/\n/g, ' ').trim();

  // Priority patterns — most specific first
  const patterns = [
    // Rs. 1,250.00  or  Rs 450
    /(?:Rs\.?|රු\.?|LKR)\s*([\d,]+(?:\.\d{1,2})?)/i,
    // Standalone price with decimal: 450.00  or  1,250.50
    /\b([\d]{1,4}(?:,\d{3})*\.\d{2})\b/,
    // Plain integer that looks like a price: 2–5 digits
    /\b(\d{2,5})\b/,
  ];

  for (const re of patterns) {
    const match = clean.match(re);
    if (match) {
      const raw = match[1].replace(/,/g, '');
      const price = parseFloat(raw);
      if (!isNaN(price) && price > 0 && price < 1000000) {
        // Try to grab a product label from nearby text
        const label = extractLabel(clean, match[0]) || 'Scanned Item';
        return { price, label };
      }
    }
  }
  return null;
};

const extractLabel = (text: string, priceStr: string): string => {
  // Take up to 40 chars before the price as a label, strip numbers/symbols
  const idx = text.indexOf(priceStr);
  const before = idx > 0 ? text.substring(Math.max(0, idx - 60), idx) : text.substring(0, 60);
  const cleaned = before.replace(/[^\w\s\-\/]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > 3 ? cleaned.slice(-40) : '';
};

// ─── Budget helpers ───────────────────────────────────────────────────────────
const getBudgetAlert = (spent: number, budget: number): BudgetAlert => {
  if (budget <= 0) return 'none';
  const pct = spent / budget;
  if (pct >= 1)    return 'over';
  if (pct >= 0.9)  return 'danger';
  if (pct >= 0.75) return 'warning';
  return 'none';
};

const ALERT_CONFIG: Record<BudgetAlert, { color: string; bg: string; msg: string }> = {
  none:    { color: '#00e56b', bg: 'rgba(0,229,160,0.08)',  msg: '' },
  warning: { color: '#ffa502', bg: 'rgba(255,165,2,0.10)',  msg: '⚠️  75% of budget used' },
  danger:  { color: '#ff6b35', bg: 'rgba(255,107,53,0.12)', msg: '🔥  90% of budget used!' },
  over:    { color: '#ff4757', bg: 'rgba(255,71,87,0.14)',  msg: '🚨  Budget exceeded!' },
};

const fmt = (n: number) => `Rs. ${Math.round(n).toLocaleString('en-LK')}`;

// ═════════════════════════════════════════════════════════════════════════════
//  APP
// ═════════════════════════════════════════════════════════════════════════════
export default function App() {

  // ── All hooks first ──────────────────────────────────────────────────────
  const [permission, requestPermission] = useCameraPermissions();

  const [tab, setTab]               = useState<Tab>('scanner');
  const [scanState, setScanState]   = useState<ScanState>('idle');
  const [items, setItems]           = useState<CartItem[]>([]);
  const [budget, setBudget]         = useState(0);
  const [budgetInput, setBudgetInput] = useState('');
  const [lastItem, setLastItem]     = useState<CartItem | null>(null);
  const [showPopup, setShowPopup]   = useState(false);
  const [errorMsg, setErrorMsg]     = useState('');
  const [rawOcrText, setRawOcrText] = useState('');
  const [manualPrice, setManualPrice] = useState('');
  const [manualLabel, setManualLabel] = useState('');
  const [showManual, setShowManual] = useState(false);

  const cameraRef  = useRef<CameraView>(null);
  const popupScale = useRef(new Animated.Value(0)).current;
  const alertShake = useRef(new Animated.Value(0)).current;
  const scanRing   = useRef(new Animated.Value(1)).current;
  const prevAlertRef = useRef<BudgetAlert>('none');

  // Derived
  const totalSpend   = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const budgetLeft   = budget - totalSpend;
  const budgetAlert  = getBudgetAlert(totalSpend, budget);
  const alertCfg     = ALERT_CONFIG[budgetAlert];
  const totalItems   = items.reduce((s, i) => s + i.quantity, 0);

  // Scan ring pulse
  useEffect(() => {
    if (scanState === 'capturing' || scanState === 'processing') {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(scanRing, { toValue: 1.08, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(scanRing, { toValue: 1,    duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      scanRing.setValue(1);
    }
  }, [scanState]);

  // Budget alert shake
  useEffect(() => {
    if (budgetAlert !== 'none' && budgetAlert !== prevAlertRef.current) {
      Vibration.vibrate([0, 80, 60, 80]);
      Animated.sequence([
        Animated.timing(alertShake, { toValue:  9, duration: 55, useNativeDriver: true }),
        Animated.timing(alertShake, { toValue: -9, duration: 55, useNativeDriver: true }),
        Animated.timing(alertShake, { toValue:  6, duration: 55, useNativeDriver: true }),
        Animated.timing(alertShake, { toValue: -6, duration: 55, useNativeDriver: true }),
        Animated.timing(alertShake, { toValue:  0, duration: 55, useNativeDriver: true }),
      ]).start();
    }
    prevAlertRef.current = budgetAlert;
  }, [budgetAlert]);

  // ── Capture & OCR ──────────────────────────────────────────────────────
  const captureAndOCR = useCallback(async () => {
    if (!cameraRef.current || scanState !== 'idle') return;

    setScanState('capturing');
    Vibration.vibrate(40);

    try {
      // Take photo
      const photo = await cameraRef.current.takePictureAsync({ base64: false, quality: 0.85 });
      if (!photo?.uri) throw new Error('Camera capture failed');

      setScanState('processing');

      // Resize to 1024px wide for faster OCR
      const resized = await manipulateAsync(
        photo.uri,
        [{ resize: { width: 1024 } }],
        { base64: true, format: SaveFormat.JPEG, compress: 0.8 }
      );

      if (!resized.base64) throw new Error('Image processing failed');

      // Run OCR
      const ocrText = await runOCR(resized.base64);
      setRawOcrText(ocrText);

      if (!ocrText.trim()) {
        setErrorMsg('No text detected. Point camera at a price tag.');
        setScanState('error');
        return;
      }

      const result = extractPrice(ocrText);

      if (!result) {
        // Show manual entry with raw text pre-filled
        setManualLabel('');
        setManualPrice('');
        setShowManual(true);
        setErrorMsg('Could not read price. Enter manually below.');
        setScanState('error');
        return;
      }

      addToCart(result.label, result.price, ocrText);

    } catch (err: any) {
      // If API key not set, demo mode
      if (VISION_API_KEY === 'GOOGLE_VISION_API_KEY') {
        const demoPrice = Math.floor(Math.random() * 2000) + 50;
        const demoLabels = ['Milk 1L', 'Bread Loaf', 'Rice 1kg', 'Coconut Oil', 'Dhal 500g', 'Sugar 1kg', 'Tea Bags', 'Biscuits'];
        const label = demoLabels[Math.floor(Math.random() * demoLabels.length)];
        addToCart(label, demoPrice, `[DEMO] Rs. ${demoPrice}`);
      } else {
        setErrorMsg(err.message || 'OCR failed. Try again.');
        setScanState('error');
      }
    }
  }, [scanState, items]);

  const addToCart = (label: string, price: number, rawText: string) => {
    const newItem: CartItem = {
      id: Date.now().toString(),
      label: label || 'Scanned Item',
      price,
      rawText,
      capturedAt: new Date(),
      quantity: 1,
    };

    setItems(prev => {
      // If same label+price already exists, bump quantity
      const match = prev.find(i => i.label === newItem.label && i.price === newItem.price);
      if (match) return prev.map(i => i.id === match.id ? { ...i, quantity: i.quantity + 1 } : i);
      return [...prev, newItem];
    });

    setLastItem(newItem);
    setShowPopup(true);
    setScanState('done');
    Vibration.vibrate([30, 20, 30]);

    Animated.spring(popupScale, { toValue: 1, friction: 5, tension: 140, useNativeDriver: true }).start();
    setTimeout(() => {
      Animated.timing(popupScale, { toValue: 0, duration: 200, useNativeDriver: true })
        .start(() => setShowPopup(false));
      setScanState('idle');
    }, 2600);
  };

  const addManual = () => {
    const price = parseFloat(manualPrice.replace(/,/g, ''));
    if (isNaN(price) || price <= 0) { Alert.alert('Invalid price', 'Enter a valid price.'); return; }
    addToCart(manualLabel || 'Manual Item', price, rawOcrText);
    setShowManual(false);
    setManualPrice('');
    setManualLabel('');
    setErrorMsg('');
  };

  // ── Cart helpers ──────────────────────────────────────────────────────
  const removeItem = (id: string) =>
    Alert.alert('Remove Item', 'Remove from cart?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => setItems(p => p.filter(i => i.id !== id)) },
    ]);

  const changeQty = (id: string, delta: number) =>
    setItems(prev =>
      prev.map(i => i.id === id ? { ...i, quantity: Math.max(0, i.quantity + delta) } : i)
          .filter(i => i.quantity > 0)
    );

  const clearCart = () =>
    Alert.alert('Clear Cart', 'Remove all items?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear All', style: 'destructive', onPress: () => setItems([]) },
    ]);

  const exportCart = async () => {
    if (!items.length) { Alert.alert('Cart Empty', 'Scan some items first.'); return; }
    const lines = items.map((i, n) =>
      `${n + 1}. ${i.label} (x${i.quantity})  ${fmt(i.price * i.quantity)}`
    );
    await Share.share({
      message:
        `🛒 PriceScan Receipt\n━━━━━━━━━━━━━━━━━━\n` +
        lines.join('\n') +
        `\n━━━━━━━━━━━━━━━━━━\nTotal : ${fmt(totalSpend)}\n` +
        (budget > 0 ? `Budget Left : ${fmt(budgetLeft)}\n` : '') +
        `\nScanned with PriceScan 📷`,
    });
  };

  const handleSetBudget = () => {
    const v = parseFloat(budgetInput.replace(/,/g, ''));
    if (!isNaN(v) && v > 0) setBudget(v);
  };

  // ── Early returns (all hooks are above) ──────────────────────────────
  if (!permission) return <View style={S.container} />;

  if (!permission.granted) {
    return (
      <View style={[S.container, S.center]}>
        <Text style={S.permIcon}>📷</Text>
        <Text style={S.permTitle}>Camera Access Needed</Text>
        <Text style={S.permSub}>PriceScan uses your camera to read price tags with OCR.</Text>
        <TouchableOpacity style={S.grantBtn} onPress={requestPermission}>
          <Text style={S.grantBtnText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isScanning = scanState === 'capturing' || scanState === 'processing';
  const scanLabel  = scanState === 'capturing' ? 'Capturing…'
                   : scanState === 'processing' ? 'Reading price…'
                   : scanState === 'done'       ? 'Added! ✓'
                   : scanState === 'error'      ? 'Try Again'
                   : '📷  Scan Price Tag';

  // ═══════════════════════════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════════════════════════
  return (
    <View style={S.container}>
      <StatusBar barStyle="light-content" backgroundColor="#07080f" />

      {/* ── Header ── */}
      <View style={S.header}>
        <View style={S.headerTop}>
          <Text style={S.logo}>PRICE<Text style={S.logoAccent}>SCAN</Text></Text>
          {VISION_API_KEY === '' && (
            <View style={S.demoBadge}><Text style={S.demoText}>DEMO MODE</Text></View>
          )}
        </View>
        <View style={S.tabRow}>
          {(['scanner', 'cart'] as Tab[]).map(t => (
            <TouchableOpacity key={t}
              style={[S.tabBtn, tab === t && S.tabBtnActive]}
              onPress={() => setTab(t)}
            >
              <Text style={[S.tabText, tab === t && S.tabTextActive]}>
                {t === 'scanner' ? '📷  Scanner' : `🛒  Cart${totalItems ? ` (${totalItems})` : ''}`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* ══════════ SCANNER TAB ══════════ */}
      {tab === 'scanner' && (
        <>
          {/* Camera */}
          <View style={S.cameraWrap}>
            <CameraView ref={cameraRef} style={S.camera} facing="back">

              {/* Dimmed overlay with cutout hint */}
              <View style={S.overlay} pointerEvents="none">
                {/* Focus box */}
                <View style={S.focusBox}>
                  <View style={[S.corner, S.cTL]} />
                  <View style={[S.corner, S.cTR]} />
                  <View style={[S.corner, S.cBL]} />
                  <View style={[S.corner, S.cBR]} />
                  {isScanning && (
                    <View style={S.scanningRow}>
                      <ActivityIndicator color="#00e5a0" size="small" />
                      <Text style={S.scanningText}>
                        {scanState === 'capturing' ? 'Capturing…' : 'Reading text…'}
                      </Text>
                    </View>
                  )}
                </View>
                <Text style={S.hint}>
                  {scanState === 'error'
                    ? '⚠ ' + errorMsg
                    : 'Point at a price tag and tap Scan'}
                </Text>
              </View>
            </CameraView>
          </View>

          {/* Bottom panel */}
          <Animated.View style={[S.panel, { transform: [{ translateX: alertShake }] }]}>

            {/* Alert banner */}
            {budgetAlert !== 'none' && (
              <View style={[S.alertBanner, { backgroundColor: alertCfg.bg, borderColor: alertCfg.color }]}>
                <Text style={[S.alertText, { color: alertCfg.color }]}>{alertCfg.msg}</Text>
              </View>
            )}

            {/* Budget row */}
            <View style={S.budgetRow}>
              <TextInput
                style={S.input}
                placeholder="Set budget (Rs.)"
                placeholderTextColor="#3a4a6a"
                keyboardType="numeric"
                value={budgetInput}
                onChangeText={setBudgetInput}
                onSubmitEditing={handleSetBudget}
              />
              <TouchableOpacity style={S.setBtn} onPress={handleSetBudget}>
                <Text style={S.setBtnText}>SET</Text>
              </TouchableOpacity>
            </View>

            {/* Stats */}
            <View style={S.statsRow}>
              <View style={S.statCard}>
                <Text style={S.statLabel}>SPENT</Text>
                <Text style={[S.statVal, { color: '#fff' }]}>{fmt(totalSpend)}</Text>
              </View>
              {budget > 0 && (
                <View style={S.statCard}>
                  <Text style={S.statLabel}>{budgetLeft >= 0 ? 'REMAINING' : 'OVER BY'}</Text>
                  <Text style={[S.statVal, { color: alertCfg.color }]}>{fmt(Math.abs(budgetLeft))}</Text>
                </View>
              )}
              <View style={S.statCard}>
                <Text style={S.statLabel}>ITEMS</Text>
                <Text style={[S.statVal, { color: '#7b8fff' }]}>{totalItems}</Text>
              </View>
            </View>

            {/* Progress bar */}
            {budget > 0 && (
              <View style={S.progTrack}>
                <View style={[S.progFill, {
                  width: `${Math.min((totalSpend / budget) * 100, 100)}%` as any,
                  backgroundColor: alertCfg.color,
                }]} />
              </View>
            )}

            {/* Manual entry (shown on OCR failure) */}
            {showManual && (
              <View style={S.manualBox}>
                <Text style={S.manualTitle}>Enter price manually</Text>
                {rawOcrText.length > 0 && (
                  <Text style={S.rawText} numberOfLines={2}>OCR: {rawOcrText.substring(0, 80)}</Text>
                )}
                <TextInput
                  style={S.input}
                  placeholder="Product name (optional)"
                  placeholderTextColor="#3a4a6a"
                  value={manualLabel}
                  onChangeText={setManualLabel}
                />
                <View style={[S.budgetRow, { marginTop: 8 }]}>
                  <TextInput
                    style={S.input}
                    placeholder="Price in Rs."
                    placeholderTextColor="#3a4a6a"
                    keyboardType="numeric"
                    value={manualPrice}
                    onChangeText={setManualPrice}
                  />
                  <TouchableOpacity style={S.setBtn} onPress={addManual}>
                    <Text style={S.setBtnText}>ADD</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Scan button */}
            <Animated.View style={{ transform: [{ scale: scanRing }] }}>
              <TouchableOpacity
                style={[S.scanBtn,
                  isScanning          && S.scanBtnActive,
                  scanState === 'done' && S.scanBtnDone,
                  scanState === 'error' && S.scanBtnError,
                ]}
                onPress={() => {
                  if (scanState === 'error') {
                    setScanState('idle');
                    setErrorMsg('');
                    setShowManual(false);
                  } else {
                    captureAndOCR();
                  }
                }}
                disabled={isScanning}
              >
                {isScanning
                  ? <ActivityIndicator color="#07080f" />
                  : <Text style={S.scanBtnText}>{scanLabel}</Text>
                }
              </TouchableOpacity>
            </Animated.View>

          </Animated.View>
        </>
      )}

      {/* ══════════ CART TAB ══════════ */}
      {tab === 'cart' && (
        <View style={S.cartWrap}>
          {items.length === 0 ? (
            <View style={S.emptyCart}>
              <Text style={S.emptyIcon}>🛒</Text>
              <Text style={S.emptyTitle}>Cart is empty</Text>
              <Text style={S.emptySub}>Go to Scanner and tap a price tag!</Text>
            </View>
          ) : (
            <>
              <FlatList
                data={items}
                keyExtractor={i => i.id}
                contentContainerStyle={{ padding: 16, paddingBottom: 220 }}
                showsVerticalScrollIndicator={false}
                renderItem={({ item }) => (
                  <View style={S.cartCard}>
                    <View style={{ flex: 1 }}>
                      <Text style={S.cartLabel} numberOfLines={2}>{item.label}</Text>
                      <Text style={S.cartTime}>
                        {item.capturedAt.toLocaleTimeString('en-LK', { hour: '2-digit', minute: '2-digit' })}
                      </Text>
                      <Text style={S.cartPrice}>{fmt(item.price)}</Text>
                    </View>
                    <View style={S.cartRight}>
                      <View style={S.qtyRow}>
                        <TouchableOpacity style={S.qtyBtn} onPress={() => changeQty(item.id, -1)}>
                          <Text style={S.qtyChar}>−</Text>
                        </TouchableOpacity>
                        <Text style={S.qtyNum}>{item.quantity}</Text>
                        <TouchableOpacity style={S.qtyBtn} onPress={() => changeQty(item.id, 1)}>
                          <Text style={S.qtyChar}>+</Text>
                        </TouchableOpacity>
                      </View>
                      <Text style={S.cartSub}>{fmt(item.price * item.quantity)}</Text>
                      <TouchableOpacity onPress={() => removeItem(item.id)}>
                        <Text style={S.delIcon}>🗑</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              />

              {/* Sticky footer */}
              <View style={S.cartFooter}>
                {budgetAlert !== 'none' && (
                  <View style={[S.alertBanner, { backgroundColor: alertCfg.bg, borderColor: alertCfg.color, marginBottom: 10 }]}>
                    <Text style={[S.alertText, { color: alertCfg.color }]}>{alertCfg.msg}</Text>
                  </View>
                )}
                <View style={S.totalRow}>
                  <Text style={S.totalLabel}>TOTAL</Text>
                  <Text style={S.totalVal}>{fmt(totalSpend)}</Text>
                </View>
                {budget > 0 && (
                  <>
                    <View style={S.progTrack}>
                      <View style={[S.progFill, {
                        width: `${Math.min((totalSpend / budget) * 100, 100)}%` as any,
                        backgroundColor: alertCfg.color,
                      }]} />
                    </View>
                    <Text style={[S.budgetLeftText, { color: alertCfg.color }]}>
                      {budgetLeft >= 0 ? `Rs. ${Math.round(budgetLeft).toLocaleString()} remaining` : `Rs. ${Math.round(-budgetLeft).toLocaleString()} over budget`}
                    </Text>
                  </>
                )}
                <View style={S.footerBtns}>
                  <TouchableOpacity style={S.shareBtn} onPress={exportCart}>
                    <Text style={S.shareBtnText}>↑  Share Receipt</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={S.clearBtn} onPress={clearCart}>
                    <Text style={S.clearBtnText}>Clear</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </>
          )}
        </View>
      )}

      {/* ── Success Popup ── */}
      {showPopup && lastItem && (
        <View style={S.popupOverlay} pointerEvents="none">
          <Animated.View style={[S.popupBox, { transform: [{ scale: popupScale }] }]}>
            <Text style={S.popupCheck}>✓</Text>
            <Text style={S.popupLabel} numberOfLines={2}>{lastItem.label}</Text>
            <Text style={S.popupPrice}>{fmt(lastItem.price)}</Text>
            <Text style={S.popupSub}>Added to cart</Text>
          </Animated.View>
        </View>
      )}
    </View>
  );
}

// ─── Design tokens ─────────────────────────────────────────────────────────
const C = {
  bg:      '#07080f',
  surface: '#0d1020',
  card:    '#131829',
  border:  '#1e2640',
  accent:  '#e58d00',
  blue:    '#ffc17b',
  text:    '#dde3f5',
  muted:   '#3a4a6a',
  warn:    '#ffa502',
  danger:  '#ff4757',
};

// ─── Styles ────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center:    { justifyContent: 'center', alignItems: 'center', padding: 32 },

  permIcon:  { fontSize: 48, marginBottom: 16 },
  permTitle: { color: C.text, fontSize: 22, fontWeight: '700', marginBottom: 8 },
  permSub:   { color: C.muted, fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 28 },
  grantBtn:  { backgroundColor: C.accent, paddingHorizontal: 32, paddingVertical: 14, borderRadius: 14 },
  grantBtnText: { color: C.bg, fontWeight: '800', fontSize: 15 },

  header: {
    backgroundColor: C.surface,
    paddingTop: Platform.OS === 'ios' ? 56 : 38,
    paddingHorizontal: 18,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  headerTop:  { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  logo:       { color: '#fff', fontSize: 21, fontWeight: '900', letterSpacing: 3, flex: 1 },
  logoAccent: { color: C.accent },
  demoBadge:  { backgroundColor: 'rgba(255,165,2,0.15)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: C.warn },
  demoText:   { color: C.warn, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  tabRow:     { flexDirection: 'row', gap: 8 },
  tabBtn:     { flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: 'center', backgroundColor: C.card },
  tabBtnActive: { backgroundColor: C.accent },
  tabText:    { color: C.muted, fontWeight: '700', fontSize: 13 },
  tabTextActive: { color: C.bg },

  cameraWrap: { flex: 1 },
  camera:     { flex: 1 },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(7,8,15,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  focusBox: {
    width: 300, height: 180,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  corner: { position: 'absolute', width: 26, height: 26, borderColor: C.accent, borderWidth: 3 },
  cTL: { top: 0,    left: 0,  borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 6 },
  cTR: { top: 0,    right: 0, borderLeftWidth: 0,  borderBottomWidth: 0, borderTopRightRadius: 6 },
  cBL: { bottom: 0, left: 0,  borderRightWidth: 0, borderTopWidth: 0,    borderBottomLeftRadius: 6 },
  cBR: { bottom: 0, right: 0, borderLeftWidth: 0,  borderTopWidth: 0,    borderBottomRightRadius: 6 },
  scanningRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  scanningText: { color: C.accent, fontSize: 13, fontWeight: '600' },
  hint: {
    position: 'absolute', bottom: -40,
    color: 'rgba(221,227,245,0.6)', fontSize: 13,
    textAlign: 'center', paddingHorizontal: 24,
  },

  panel: {
    backgroundColor: C.surface,
    padding: 18,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: C.border,
  },
  alertBanner: {
    borderWidth: 1, borderRadius: 10,
    paddingVertical: 8, paddingHorizontal: 14,
    marginBottom: 12, alignItems: 'center',
  },
  alertText: { fontWeight: '700', fontSize: 13 },

  budgetRow:  { flexDirection: 'row', gap: 10, marginBottom: 14 },
  input: {
    flex: 1, backgroundColor: C.card, color: C.text,
    padding: 12, borderRadius: 10, fontSize: 14,
    borderWidth: 1, borderColor: C.border,
  },
  setBtn:     { backgroundColor: C.accent, paddingHorizontal: 18, justifyContent: 'center', borderRadius: 10 },
  setBtnText: { color: C.bg, fontWeight: '800', fontSize: 13, letterSpacing: 0.8 },

  statsRow:  { flexDirection: 'row', gap: 10, marginBottom: 12 },
  statCard:  { flex: 1, backgroundColor: C.card, borderRadius: 12, padding: 11, borderWidth: 1, borderColor: C.border },
  statLabel: { color: C.muted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginBottom: 4 },
  statVal:   { fontSize: 15, fontWeight: '800' },

  progTrack: { height: 4, backgroundColor: C.card, borderRadius: 2, marginBottom: 14, overflow: 'hidden' },
  progFill:  { height: '100%', borderRadius: 2 },

  manualBox: {
    backgroundColor: C.card, borderRadius: 14,
    padding: 14, marginBottom: 12,
    borderWidth: 1, borderColor: C.warn,
  },
  manualTitle: { color: C.warn, fontSize: 13, fontWeight: '700', marginBottom: 8 },
  rawText:     { color: C.muted, fontSize: 11, marginBottom: 8, fontStyle: 'italic' },

  scanBtn: {
    backgroundColor: C.accent, padding: 16,
    borderRadius: 14, alignItems: 'center',
    shadowColor: C.accent, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35, shadowRadius: 12, elevation: 8,
  },
  scanBtnActive: { backgroundColor: '#009e70' },
  scanBtnDone:   { backgroundColor: '#00c47a' },
  scanBtnError:  { backgroundColor: '#ff4757' },
  scanBtnText:   { color: C.bg, fontSize: 16, fontWeight: '800', letterSpacing: 0.5 },

  cartWrap:   { flex: 1 },
  emptyCart:  { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  emptyIcon:  { fontSize: 54, marginBottom: 16 },
  emptyTitle: { color: C.text, fontSize: 20, fontWeight: '700', marginBottom: 8 },
  emptySub:   { color: C.muted, fontSize: 14, textAlign: 'center' },

  cartCard: {
    backgroundColor: C.card, borderRadius: 14,
    padding: 14, marginBottom: 10,
    flexDirection: 'row', gap: 12,
    borderWidth: 1, borderColor: C.border,
  },
  cartLabel: { color: C.text, fontSize: 14, fontWeight: '600', marginBottom: 3 },
  cartTime:  { color: C.muted, fontSize: 11, marginBottom: 6 },
  cartPrice: { color: C.accent, fontSize: 17, fontWeight: '800' },
  cartRight: { alignItems: 'flex-end', justifyContent: 'space-between' },
  qtyRow:    { flexDirection: 'row', alignItems: 'center', gap: 8 },
  qtyBtn:    { backgroundColor: C.border, width: 28, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  qtyChar:   { color: C.text, fontSize: 18, lineHeight: 22 },
  qtyNum:    { color: C.text, fontSize: 15, fontWeight: '700', minWidth: 22, textAlign: 'center' },
  cartSub:   { color: '#fff', fontSize: 15, fontWeight: '800' },
  delIcon:   { fontSize: 16, padding: 4 },

  cartFooter: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: C.surface, padding: 18,
    borderTopWidth: 1, borderTopColor: C.border,
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
  },
  totalRow:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  totalLabel:    { color: C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 2 },
  totalVal:      { color: '#fff', fontSize: 26, fontWeight: '900' },
  budgetLeftText:{ fontSize: 12, fontWeight: '600', marginBottom: 12, textAlign: 'right' },
  footerBtns:    { flexDirection: 'row', gap: 10 },
  shareBtn:      { flex: 1, backgroundColor: C.accent, padding: 14, borderRadius: 12, alignItems: 'center' },
  shareBtnText:  { color: C.bg, fontWeight: '800', fontSize: 14 },
  clearBtn:      { backgroundColor: 'rgba(255,71,87,0.12)', paddingHorizontal: 20, padding: 14, borderRadius: 12, justifyContent: 'center', borderWidth: 1, borderColor: C.danger },
  clearBtnText:  { color: C.danger, fontWeight: '700', fontSize: 14 },

  popupOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center', alignItems: 'center',
  },
  popupBox: {
    backgroundColor: C.card, padding: 32, borderRadius: 24,
    borderWidth: 1, borderColor: C.accent, width: '75%', alignItems: 'center',
    shadowColor: C.accent, shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4, shadowRadius: 28, elevation: 14,
  },
  popupCheck: { fontSize: 36, color: C.accent, marginBottom: 8 },
  popupLabel: { color: C.text, fontSize: 15, textAlign: 'center', marginBottom: 10 },
  popupPrice: { color: C.accent, fontSize: 36, fontWeight: '900', marginBottom: 6 },
  popupSub:   { color: C.muted, fontSize: 13 },
});