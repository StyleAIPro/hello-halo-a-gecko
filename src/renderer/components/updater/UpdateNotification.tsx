/**
 * Update Notification Listener
 *
 * Listens for updater IPC events and pushes toasts into the unified
 * notification store. No longer renders its own UI — the global
 * NotificationToast component handles all rendering.
 *
 * Behavior:
 * - 'downloaded': Update ready to install (Windows: auto-install, macOS: manual download)
 * - 'manual-download': Need manual download (macOS platform or auto-download failed)
 *
 * The toast is sticky (duration=0) since updates are important and
 * should not auto-dismiss. Uses the 'success' variant with emerald accent.
 */

import { useEffect, useRef } from 'react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { useNotificationStore } from '../../stores/notification.store'

const isMac = navigator.platform.includes('Mac')

// Stable toast ID so repeated events replace rather than duplicate
const UPDATE_TOAST_ID = 'updater-download-ready'

// Parse release notes to a single summary string
function formatReleaseNotes(notes: string | { version: string; note: string }[] | undefined): string {
  if (!notes) return ''

  let lines: string[] = []
  if (typeof notes === 'string') {
    lines = notes
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => line.replace(/^[-*]\s*/, ''))
  } else if (Array.isArray(notes)) {
    lines = notes.map(item => item.note)
  }

  return lines.length > 0 ? lines.join(' · ') : ''
}

export function UpdateNotification() {
  const { t } = useTranslation()
  const show = useNotificationStore((s) => s.show)

  // Keep a ref to the latest closure values for the action callbacks
  const stateRef = useRef<{ isManualDownload: boolean; downloadUrl: string }>({
    isManualDownload: false,
    downloadUrl: '',
  })

  useEffect(() => {
    const unsubscribe = api.onUpdaterStatus((data) => {
      console.log('[UpdateNotification] Received update status:', data)

      if ((data.status === 'downloaded' || data.status === 'manual-download') && data.version) {
        const isManual = data.status === 'manual-download'
        const url = (data as { downloadUrl?: string }).downloadUrl || ''

        // Store for action callback
        stateRef.current = { isManualDownload: isManual, downloadUrl: url }

        const notes = formatReleaseNotes(data.releaseNotes)

        show({
          id: UPDATE_TOAST_ID,
          title: t('New version Halo {{version}} available', { version: data.version }),
          body: notes || (isManual || isMac ? t('Click to download') : t('Click to restart and complete update')),
          variant: 'success',
          duration: 0, // Sticky — user must act or dismiss
          action: {
            label: isManual || isMac ? t('Go to download') : t('Restart now'),
            onClick: () => {
              const { isManualDownload, downloadUrl } = stateRef.current
              if (isManualDownload || isMac) {
                if (downloadUrl) window.open(downloadUrl, '_blank')
              } else {
                api.installUpdate()
              }
            },
          },
          secondaryAction: {
            label: t('Later'),
            onClick: () => { /* dismiss is handled by NotificationToast */ },
          },
        })
      }
    })

    return () => { unsubscribe() }
  }, [show, t])

  // No longer renders its own UI — the unified NotificationToast handles it
  return null
}
