import {useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {catalogService} from '../../../services';
import {useActions, usePluginState, usePlayerState} from '../../../store';
import type {TrackQuality} from '../../../types';
import {QUALITIES_DESC, qualityLabelKey} from '../../../utils/quality';
import {UnderlineRadioGroup} from '../../ui/radio-group';
import styles from './PlaybackOptions.module.css';

/**
 * 音源 / 音质选择（手机抽屉与歌词页共用）。
 *
 * 桌面播放条用 `SourcePicker` / `QualityPicker`（下拉浮层）；手机宽度放不下那种浮层，
 * 改成下划线单选，选项与 store 行为仍与桌面完全同源。
 */
export function PlaybackOptions() {
    const {t} = useTranslation();
    const {candidates, activeSource, quality} = usePlayerState();
    const {switchSource, reloadSource} = useActions().player;
    const {setPreferredSource, setPreferredQuality} = useActions().ui;
    const pluginList = usePluginState().list;

    const sourceNames = useMemo(() => {
        const map = new Map<string, string>();
        pluginList.forEach((plugin) => map.set(plugin.id, plugin.name));
        catalogService.listSources().forEach((source) => map.set(source.id, source.name));
        return (id: string) => map.get(id) ?? id;
    }, [pluginList]);

    const sourceOptions = useMemo(() => {
        const values = new Set<string>(candidates.map((candidate) => candidate.source));
        if (activeSource) values.add(activeSource);
        return [
            {value: 'auto', label: t('source.auto')},
            ...[...values].map((id) => ({value: id, label: sourceNames(id)})),
        ];
    }, [candidates, activeSource, sourceNames, t]);

    if (sourceOptions.length <= 1 && !quality) return null;

    return (
        <div className={styles.root}>
            {sourceOptions.length > 1 && (
                <div className={styles.field}>
                    <span className={styles.label}>{t('source.label')}</span>
                    <UnderlineRadioGroup
                        name="playback-source"
                        value={activeSource ?? 'auto'}
                        options={sourceOptions}
                        onChange={(value) => {
                            if (value === 'auto') {
                                setPreferredSource(null);
                                reloadSource();
                                return;
                            }
                            switchSource(value);
                        }}
                    />
                </div>
            )}

            <div className={styles.field}>
                <span className={styles.label}>{t('quality.label')}</span>
                <UnderlineRadioGroup
                    name="playback-quality"
                    value={(quality ?? 'standard') as TrackQuality}
                    options={QUALITIES_DESC.map((value) => ({
                        value,
                        label: t(qualityLabelKey(value)),
                    }))}
                    onChange={(value) => setPreferredQuality(value as TrackQuality)}
                />
            </div>
        </div>
    );
}

export default PlaybackOptions;
