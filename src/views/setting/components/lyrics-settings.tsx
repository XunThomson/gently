import {useCallback, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {UnderlineRadioGroup} from '../../../components/ui/radio-group';
import {windowService} from '../../../services';
import {
    readLyricsWindowSettings,
    writeLyricsWindowSettings,
    type LyricsBackground,
} from '../../../utils/lyricsWindowSettings';
import {Field} from './field';

/**
 * 桌面歌词窗口的设置项（锁定 / 背景 / 逐字展开）。
 *
 * 锁定（点击穿透）的状态持久化在 localStorage，解锁只能在这里——锁定后
 * 歌词窗口自己收不到点击，靠它自己的按钮解锁是死路。
 *
 * 只渲染组内条目：标题与说明由外层 `Section` 负责。
 */
export function LyricsSettings() {
    const {t} = useTranslation();
    const [lyricsLocked, setLyricsLockedState] = useState(() => windowService.desktopLyricsLocked());
    /* 歌词窗口的观感设置（背景 / 逐字展开）：与歌词窗口读同一份 localStorage */
    const [lyricsWindow, setLyricsWindow] = useState(readLyricsWindowSettings);

    /* 先切界面状态再落盘：锁定是个开关，点下去就该立刻看到结果；
       写盘/窗口调用失败只记日志，不把开关弹回去（那会让人以为点击没生效） */
    const setLyricsLocked = useCallback((locked: boolean) => {
        setLyricsLockedState(locked);
        void windowService.setDesktopLyricsLocked(locked);
    }, []);

    return (
        <>
            <Field label={t('page.setting.lyricsLock')} hint={t('page.setting.lyricsLockHint')}>
                <UnderlineRadioGroup
                    name="lyrics-lock"
                    value={lyricsLocked ? 'lock' : 'free'}
                    onChange={(value) => void setLyricsLocked(value === 'lock')}
                    options={[
                        {value: 'free', label: t('page.setting.lyricsLockOff')},
                        {value: 'lock', label: t('page.setting.lyricsLockOn')},
                    ]}
                />
            </Field>

            {/* 背景三档：透明背景在浅色壁纸上可能看不清字，所以默认仍是不透明 */}
            <Field label={t('page.setting.lyricsBackground')}>
                <UnderlineRadioGroup
                    name="lyrics-background"
                    value={lyricsWindow.background}
                    onChange={(value) =>
                        setLyricsWindow(writeLyricsWindowSettings({background: value as LyricsBackground}))
                    }
                    options={[
                        {value: 'solid', label: t('page.setting.lyricsBgSolid')},
                        {value: 'translucent', label: t('page.setting.lyricsBgTranslucent')},
                        {value: 'transparent', label: t('page.setting.lyricsBgTransparent')},
                    ]}
                />
            </Field>

            {/* 逐字展开（卡拉 OK 式）：默认关闭，用户显式打开 */}
            <Field label={t('page.setting.lyricsSweep')} hint={t('page.setting.lyricsSweepHint')}>
                <UnderlineRadioGroup
                    name="lyrics-sweep"
                    value={lyricsWindow.sweep ? 'on' : 'off'}
                    onChange={(value) => setLyricsWindow(writeLyricsWindowSettings({sweep: value === 'on'}))}
                    options={[
                        {value: 'off', label: t('page.setting.lyricsSweepOff')},
                        {value: 'on', label: t('page.setting.lyricsSweepOn')},
                    ]}
                />
            </Field>
        </>
    );
}

export default LyricsSettings;
