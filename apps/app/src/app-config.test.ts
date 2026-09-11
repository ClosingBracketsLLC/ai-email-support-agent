import { BRAND } from '@aesa/contracts'
import appJson from '../app.json'

type Plugin = string | [string, Record<string, unknown>]
const plugin = (name: string) => (appJson.expo.plugins as Plugin[]).find((p): p is [string, Record<string, unknown>] => Array.isArray(p) && p[0] === name)![1]

test('app.json references the generated assets and the brand tokens', () => {
  expect(appJson.expo.name).toBe('aesa')
  expect(appJson.expo.icon).toBe('./assets/icon.png')
  expect(appJson.expo.web.favicon).toBe('./assets/favicon.png')
  expect(appJson.expo.android.adaptiveIcon).toEqual({ foregroundImage: './assets/adaptive-icon.png', backgroundColor: BRAND.dark.night })
  expect(plugin('expo-splash-screen')).toEqual({ backgroundColor: BRAND.dark.night, image: './assets/splash-icon.png', imageWidth: BRAND.mark.raster.splashImageWidth })
  expect(plugin('expo-notifications')).toEqual({ icon: './assets/notification-icon.png', color: BRAND.light.primary })
})
