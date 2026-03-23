/**
 * 설정 페이지
 */
import React, { useEffect, useState } from 'react'
import { Button } from '../components/common/Button'
import { useAppStore } from '../store/appStore'
import { AppSettings } from '../../main/services/SettingsService'

export function SettingsPage() {
  const { navigateTo, showNotification } = useAppStore()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.electronAPI.invoke<{ success: boolean; data: AppSettings }>('settings:get')
      .then((resp) => { if (resp.success) setSettings(resp.data) })
  }, [])

  const handleSave = async () => {
    if (!settings) return
    setSaving(true)
    try {
      await window.electronAPI.invoke('settings:set', settings)
      showNotification('success', '설정이 저장되었습니다.')
    } catch {
      showNotification('error', '설정 저장 실패')
    } finally {
      setSaving(false)
    }
  }

  const handleChooseOutputDir = async () => {
    const resp = await window.electronAPI.invoke<{ success: boolean; data: string }>('settings:choose-output-dir')
    if (resp.success && settings) {
      setSettings({ ...settings, outputDir: resp.data })
    }
  }

  if (!settings) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigateTo('home')} className="text-gray-400 hover:text-gray-200 transition-colors">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-xl font-bold text-gray-100">설정</h1>
      </div>

      <div className="space-y-5 max-w-2xl">
        {/* 출력 설정 */}
        <section className="bg-surface-800 rounded-2xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">출력 설정</h2>

          {/* 출력 폴더 */}
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">기본 출력 폴더</label>
            <div className="flex gap-2">
              <input
                value={settings.outputDir}
                readOnly
                className="flex-1 bg-surface-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 font-mono truncate"
              />
              <Button variant="secondary" size="sm" onClick={handleChooseOutputDir}>
                변경
              </Button>
            </div>
          </div>

          {/* 포맷 */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">출력 포맷</label>
              <select
                value={settings.outputFormat}
                onChange={(e) => setSettings({ ...settings, outputFormat: e.target.value as AppSettings['outputFormat'] })}
                className="w-full bg-surface-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-violet-500 focus:outline-none"
              >
                <option value="wav">WAV</option>
                <option value="flac">FLAC</option>
                <option value="mp3">MP3</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">비트 뎁스</label>
              <select
                value={settings.outputBitDepth}
                onChange={(e) => setSettings({ ...settings, outputBitDepth: parseInt(e.target.value) as AppSettings['outputBitDepth'] })}
                className="w-full bg-surface-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-violet-500 focus:outline-none"
              >
                <option value={16}>16-bit</option>
                <option value={24}>24-bit</option>
                <option value={32}>32-bit</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">샘플레이트</label>
              <select
                value={settings.outputSampleRate}
                onChange={(e) => setSettings({ ...settings, outputSampleRate: parseInt(e.target.value) as AppSettings['outputSampleRate'] })}
                className="w-full bg-surface-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-violet-500 focus:outline-none"
              >
                <option value={44100}>44.1 kHz</option>
                <option value={48000}>48 kHz</option>
                <option value={96000}>96 kHz</option>
              </select>
            </div>
          </div>

          {/* 파일명 패턴 */}
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">출력 파일명 패턴</label>
            <input
              value={settings.outputFilenamePattern}
              onChange={(e) => setSettings({ ...settings, outputFilenamePattern: e.target.value })}
              className="w-full bg-surface-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:border-violet-500 focus:outline-none"
              placeholder="{original}_mastered"
            />
            <p className="text-xs text-gray-600 mt-1">{'{original}'} = 원본 파일명 (확장자 제외)</p>
          </div>
        </section>

        {/* 마스터링 기본값 */}
        <section className="bg-surface-800 rounded-2xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">마스터링 기본값</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">기본 타깃 LUFS</label>
              <input
                type="number"
                value={settings.targetLUFS}
                min={-30} max={-6} step={0.5}
                onChange={(e) => setSettings({ ...settings, targetLUFS: parseFloat(e.target.value) })}
                className="w-full bg-surface-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:border-violet-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">기본 True Peak 한계 (dBTP)</label>
              <input
                type="number"
                value={settings.targetTruePeak}
                min={-6} max={0} step={0.1}
                onChange={(e) => setSettings({ ...settings, targetTruePeak: parseFloat(e.target.value) })}
                className="w-full bg-surface-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:border-violet-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1.5">처리 품질</label>
            <div className="grid grid-cols-3 gap-2">
              {(['fast', 'standard', 'high'] as const).map((q) => (
                <button
                  key={q}
                  onClick={() => setSettings({ ...settings, processingQuality: q })}
                  className={`py-2 rounded-lg text-sm font-medium transition-all ${
                    settings.processingQuality === q
                      ? 'bg-violet-600 text-white'
                      : 'bg-surface-900 text-gray-400 hover:text-gray-200 border border-gray-700'
                  }`}
                >
                  {q === 'fast' ? '빠름' : q === 'standard' ? '표준' : '고품질'}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-600 mt-1.5">
              표준: 30초 처리 (3분 파일 기준) · 고품질: 더 정밀한 loudnorm 알고리즘 적용
            </p>
          </div>
        </section>

        {/* 저장 버튼 */}
        <Button size="lg" className="w-full" onClick={handleSave} loading={saving}>
          설정 저장
        </Button>
      </div>
    </div>
  )
}
