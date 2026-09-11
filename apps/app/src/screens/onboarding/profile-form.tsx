import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { TONES, UpdateProfileInput, deriveAllowedHosts, type Tone } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { TextField } from '@/components/text-field'
import { Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { radius, spacing, typeScale, useColors } from '@/theme'

export interface ProfileInitial { websiteUrl: string | null; description: string | null; tone: Tone; contactPhone: string | null; contactUrls: string[] }
const TONE_LABEL: Record<Tone, string> = { friendly: 'Friendly', formal: 'Formal', concise: 'Concise' }

/** Shared by onboarding step 1 and Settings → Workspace. Saves through workspace.updateProfile. */
export function ProfileForm({ initial, submitLabel, onSaved }: { initial: ProfileInitial; submitLabel: string; onSaved: () => void }) {
  const c = useColors()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [websiteUrl, setWebsiteUrl] = useState(initial.websiteUrl ?? '')
  const [description, setDescription] = useState(initial.description ?? '')
  const [tone, setTone] = useState<Tone>(initial.tone)
  const [contactPhone, setContactPhone] = useState(initial.contactPhone ?? '')
  const [contactUrls, setContactUrls] = useState(initial.contactUrls.join('\n'))
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  // Bumped by every setter. Lets a save's onSuccess tell whether the user edited the form again while that
  // save was in flight, so it never clears `dirty` out from under a newer, not-yet-saved edit.
  const editVersion = useRef(0)
  const pendingVersion = useRef<number | null>(null)

  // A background refetch (window focus, another device's save) must not silently clobber what's on screen.
  // While the form is untouched, keep it in sync with the server; once the user edits anything, their
  // in-progress draft wins over any later refetch — last write wins — until the next successful save.
  useEffect(() => {
    if (dirty) return
    setWebsiteUrl(initial.websiteUrl ?? '')
    setDescription(initial.description ?? '')
    setTone(initial.tone)
    setContactPhone(initial.contactPhone ?? '')
    setContactUrls(initial.contactUrls.join('\n'))
  }, [dirty, initial.websiteUrl, initial.description, initial.tone, initial.contactPhone, initial.contactUrls.join('\n')])

  function onWebsiteUrlChange(v: string) { setDirty(true); editVersion.current += 1; setWebsiteUrl(v) }
  function onDescriptionChange(v: string) { setDirty(true); editVersion.current += 1; setDescription(v) }
  function onToneChange(t: Tone) { setDirty(true); editVersion.current += 1; setTone(t) }
  function onContactPhoneChange(v: string) { setDirty(true); editVersion.current += 1; setContactPhone(v) }
  function onContactUrlsChange(v: string) { setDirty(true); editVersion.current += 1; setContactUrls(v) }

  const draft = useMemo(() => ({
    websiteUrl: websiteUrl.trim() ? websiteUrl.trim() : null,
    description: description.trim(),
    tone,
    contactPhone: contactPhone.trim() ? contactPhone.trim() : null,
    contactUrls: contactUrls.split('\n').map((u) => u.trim()).filter(Boolean),
  }), [websiteUrl, description, tone, contactPhone, contactUrls])
  const parsed = UpdateProfileInput.safeParse(draft)
  const hosts = parsed.success ? deriveAllowedHosts(parsed.data.websiteUrl, parsed.data.contactUrls) : []

  const save = useMutation(trpc.workspace.updateProfile.mutationOptions({
    onSuccess: async () => {
      // Invalidate (and let the refetch land) before deciding whether to clear `dirty` — TanStack Query keeps
      // the previous `initial` in place during the background refetch, so clearing `dirty` any earlier would
      // let the re-seed effect briefly clobber the screen with the pre-save data. Only clear it if nothing was
      // typed since this save started; an edit made while it was in flight must keep winning.
      await queryClient.invalidateQueries({ queryKey: trpc.workspace.get.queryKey() })
      if (editVersion.current === pendingVersion.current) setDirty(false)
      onSaved()
    },
    onError: () => setError('Could not save. Check the URLs and try again.'),
  }))

  function submit() {
    if (!parsed.success || save.isPending) return
    setError(null)
    pendingVersion.current = editVersion.current
    save.mutate(parsed.data)
  }

  return (
    <View style={styles.form}>
      <TextField label="Website" value={websiteUrl} onChangeText={onWebsiteUrlChange} placeholder="https://acme.com" autoCapitalize="none" keyboardType="url" testID="website" error={websiteUrl.trim() && !parsed.success && parsed.error.issues.some((i) => i.path[0] === 'websiteUrl') ? 'Must be an http(s) URL' : null} />
      <TextField label="One line about the business" value={description} onChangeText={onDescriptionChange} placeholder="We sell handmade socks and ship worldwide." maxLength={500} testID="description" />
      <View style={styles.tones}>
        <Muted>Tone</Muted>
        <View style={styles.toneRow}>
          {TONES.map((t) => (
            <Pressable key={t} role="radio" accessibilityState={{ checked: tone === t }} onPress={() => onToneChange(t)} testID={`tone-${t}`}
              style={[styles.tone, { borderColor: tone === t ? c.primary : c.border, backgroundColor: tone === t ? c.primaryTint : c.bg }]}>
              <Text style={[typeScale.body, { color: c.text }]}>{TONE_LABEL[t]}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <TextField label="Phone the agent may share (optional)" value={contactPhone} onChangeText={onContactPhoneChange} keyboardType="phone-pad" testID="phone" />
      <TextField label="Links the agent may share (one per line, optional)" value={contactUrls} onChangeText={onContactUrlsChange} multiline numberOfLines={3} autoCapitalize="none" placeholder={'https://acme.com/contact\nhttps://acme.com/returns'} testID="contact-urls" />
      <Card testID="guardrail-summary">
        <Muted>Guardrail</Muted>
        <Text style={[typeScale.body, { color: c.text }]}>{hosts.length ? `Replies may link only to ${hosts.join(', ')}.` : 'Replies will contain no links until you add a website or contact links.'}</Text>
      </Card>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <Button label={submitLabel} onPress={submit} loading={save.isPending} disabled={!parsed.success} testID="save-profile" />
    </View>
  )
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
  tones: { gap: spacing.xs },
  toneRow: { flexDirection: 'row', gap: spacing.sm },
  tone: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
})
