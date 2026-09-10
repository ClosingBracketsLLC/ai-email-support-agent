import { BRAND } from '@aesa/contracts'
import Svg, { G, Path } from 'react-native-svg'
import { useColors } from '@/theme'

const M = BRAND.paths.mark
const W = BRAND.paths.wordmark
const LK = BRAND.paths.lockupHorizontal
const MARK_ASPECT = 1277 / 918
const WORDMARK_ASPECT = 3383 / 920

/** The æ mark (spec §2.1) at `height` px in the theme primary — azure on light, lifted on dark — unless `color` names one of the other colourways. Callers keep it ≥ 16 px bare. */
export function Mark({ height = 24, color, testID = 'brand-mark' }: { height?: number; color?: string; testID?: string }) {
  const c = useColors()
  return (
    <Svg width={height * MARK_ASPECT} height={height} viewBox={M.viewBox} accessibilityRole="image" accessibilityLabel="aesa" testID={testID}>
      <Path d={M.d} fill={color ?? c.primary} />
    </Svg>
  )
}

/** The `aesa` wordmark as outlines (spec §2.2) in the text colour. */
export function Wordmark({ height = 20, color, testID = 'brand-wordmark' }: { height?: number; color?: string; testID?: string }) {
  const c = useColors()
  return (
    <Svg width={height * WORDMARK_ASPECT} height={height} viewBox={W.viewBox} accessibilityRole="image" accessibilityLabel="aesa" testID={testID}>
      <Path d={W.d} fill={color ?? c.text} />
    </Svg>
  )
}

/**
 * The horizontal lockup, drawn from the SAME transforms brand/lockup-horizontal.svg was generated with
 * (compose.ts → BRAND.paths.lockupHorizontal), so the app and the assets can never drift apart. `height`
 * is the whole lockup's height in px; the mark inside it is 24 px tall at height ≈ 24 (spec minimum in a lockup).
 */
export function Lockup({ height = 24, testID = 'brand-lockup' }: { height?: number; testID?: string }) {
  const c = useColors()
  return (
    <Svg width={height * (LK.width / LK.height)} height={height} viewBox={LK.viewBox} accessibilityRole="image" accessibilityLabel="aesa" testID={testID}>
      <G transform={LK.markTransform}><Path d={M.d} fill={c.primary} /></G>
      <G transform={LK.wordmarkTransform}><Path d={W.d} fill={c.text} /></G>
    </Svg>
  )
}
