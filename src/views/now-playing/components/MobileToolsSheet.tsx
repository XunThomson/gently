import {useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {useTranslation} from 'react-i18next';
import {useBackToClose} from '../../../hooks/useBackToClose';
import {useSwipeDownClose} from '../../../hooks/useSwipeDownClose';
import {QueuePanel} from '../../../components/shell/player-bar';
import {PlaybackTools} from './PlaybackTools';
import {PlaybackOptions} from '../../../components/shell/mobile/PlaybackOptions';
import {LyricsTools} from './LyricsTools';
import styles from './MobileToolsSheet.module.css';

export type MobileToolsTab = 'playback' | 'quality' | 'lyrics' | 'queue';

const TABS: readonly MobileToolsTab[] = ['playback', 'quality', 'lyrics', 'queue'];

/**
 * 手机歌词页的底部工具面板（R144）。
 *
 * 歌词页底部只放图标，具体设置收进这个面板：播放（模式 / 定时关闭 / 收藏 / 下载 /
 * 歌单 / 音源音质）、歌词（时间轴校正 / 来源 / 搜索）、队列。
 *
 * 与 R143 的 tool tabs 区别：那是「歌词下方常驻一排 tab」，会把歌词区压小；
 * 主流播放器是「图标 → 底部面板」，歌词始终占主视觉。面板同一时间只显示一个 tab。
 * 关闭：下拉抓手/标题、点遮罩、系统返回；不放 ✕（R145 用户要求）。
 *
 * 必须 portal 到 body：歌词页的祖先有 `backdrop-filter`，会成为 `position: fixed`
 * 的包含块（R139 踩过），面板会被困在页面里。
 */
export function MobileToolsSheet({
    initialTab,
    onClose,
}: {
    initialTab: MobileToolsTab;
    onClose: () => void;
}) {
    const {t} = useTranslation();
    const [tab, setTab] = useState<MobileToolsTab>(initialTab);
    const [visited, setVisited] = useState<MobileToolsTab[]>([initialTab]);

    useBackToClose(true, onClose);
    const sheetRef = useRef<HTMLDivElement | null>(null);
    const {dragY, dragging, bind} = useSwipeDownClose(onClose, 80, sheetRef);

    if (typeof document === 'undefined') return null;

    const label = (id: MobileToolsTab): string => {
        if (id === 'playback') return t('page.nowPlaying.playbackTitle');
        if (id === 'quality') return t('quality.label');
        if (id === 'lyrics') return t('page.nowPlaying.toolsToggle');
        return t('player.queue');
    };

    const select = (id: MobileToolsTab) => {
        setTab(id);
        setVisited((prev) => (prev.includes(id) ? prev : [...prev, id]));
    };

    return createPortal(
        <div className={styles.scrim} onClick={onClose}>
            <div
                className={styles.sheet}
                ref={sheetRef}
                role="dialog"
                aria-modal="true"
                aria-label={label(tab)}
                data-dragging={dragging}
                style={dragY > 0 ? {transform: `translateY(${dragY}px)`} : undefined}
                onClick={(event) => event.stopPropagation()}
            >
                <div className={styles.grabber} aria-hidden="true" {...bind}>
                    <div className={styles.grabberBar}/>
                </div>

                <div className={styles.head} {...bind}>
                    <div className={styles.tabs} role="group" aria-label={t('page.nowPlaying.toolTabs')}>
                        {TABS.map((id) => (
                            <button
                                key={id}
                                type="button"
                                className={styles.tab}
                                data-active={tab === id}
                                aria-pressed={tab === id}
                                onClick={() => select(id)}
                            >
                                {label(id)}
                            </button>
                        ))}
                    </div>
                </div>

                <div className={styles.body}>
                    {visited.includes('playback') && (
                        <div role="region" aria-label={label('playback')} hidden={tab !== 'playback'}>
                            <PlaybackTools onCollapse={onClose}/>
                        </div>
                    )}
                    {visited.includes('quality') && (
                        <div role="region" aria-label={label('quality')} hidden={tab !== 'quality'}>
                            <PlaybackOptions/>
                        </div>
                    )}
                    {visited.includes('lyrics') && (
                        <div role="region" aria-label={label('lyrics')} hidden={tab !== 'lyrics'}>
                            <LyricsTools active={tab === 'lyrics'}/>
                        </div>
                    )}
                    {visited.includes('queue') && (
                        <div role="region" aria-label={label('queue')} hidden={tab !== 'queue'}>
                            <QueuePanel inline onClose={onClose}/>
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}

export default MobileToolsSheet;
