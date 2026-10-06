import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import zh from './locales/zh.json'
import en from './locales/en.json'

export const SUPPORTED_LANGS = ['zh', 'en'] as const
export type Lang = (typeof SUPPORTED_LANGS)[number]

i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
        resources: {
            zh: { translation: zh },
            en: { translation: en },
        },
        fallbackLng: 'zh',
        supportedLngs: SUPPORTED_LANGS,
        nonExplicitSupportedLngs: true, // en-US → en
        load: 'languageOnly',           // 去掉地区后缀
        interpolation: { escapeValue: false },
        detection: {
            order: ['localStorage', 'navigator'],
            caches: ['localStorage'],
            lookupLocalStorage: 'lang',
        },
    })

export default i18n