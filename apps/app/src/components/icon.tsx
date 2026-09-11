import { BRAND, type IconName } from '@aesa/contracts'
import Svg, { Path } from 'react-native-svg'

export type { IconName }
export const ICON_NAMES = Object.keys(BRAND.icons) as IconName[]

/** One of the eight product icons (spec §5): the 24-unit grid, a 2-unit round stroke, one colour, no fill. Path data comes from brand/icons/*.svg through the generated BRAND. */
export function Icon({ name, size = 24, color, testID }: { name: IconName; size?: number; color: string; testID?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" accessibilityRole="image" testID={testID ?? `icon-${name}`}>
      {BRAND.icons[name].map((d, i) => <Path key={i} d={d} />)}
    </Svg>
  )
}
