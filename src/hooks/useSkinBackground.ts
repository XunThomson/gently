import {useCallback} from 'react';
import type {ThemeSkin} from '../theme';
import {backgroundService} from '../services';
import {useActions, useSelect} from '../store';
import type {BackgroundKind} from '../utils/backgroundSettings';
import {
    mergeSkinBackgroundOptions,
    readSkinBackgroundHint,
    skinBackgroundAssetId,
} from '../utils/skinPackage';

/**
 * 把**主题包自带的背景**接到播放器外壳上（R87）。
 *
 * 三件事：
 * 1. `bindSkinBackground`：导入主题包时把背景素材存进 IndexedDB，键固定为 `skin:<皮肤 id>`；
 * 2. `applySkinBackground`：切到某套皮肤时，把它的背景与展示参数应用到 `ui.background`；
 * 3. 素材不在（只导了 JSON、或清过站点数据）时**只应用参数**，不把背景清空——
 *    用户当前正在用的背景不该因为换主题而消失。
 *
 * 设置页里的背景参数仍然可用，作为微调：这里的 `options` 只覆盖皮肤显式给了值的项。
 */
export function useSkinBackground() {
    const {setBackgroundEnabled, setBackgroundKind, setBackgroundAsset, setBackgroundWeb, setBackgroundOptions} =
        useActions().ui;
    const current = useSelect((s) => s.ui.background.options);

    /** 导入/替换某套主题的背景素材（同一个 `skin:<id>` 键覆盖写入） */
    const bindSkinBackground = useCallback(
        async (skinId: string, file: File, kind: BackgroundKind): Promise<boolean> => {
            const id = skinBackgroundAssetId(skinId);
            if (kind === 'web') {
                const saved = await backgroundService.saveWeb(file, id);
                return saved.ok;
            }
            const saved = await backgroundService.save(file, id);
            return saved.ok;
        },
        [],
    );

    /**
     * 应用某套皮肤的背景。
     *
     * 返回 `applied`（素材在）/ `options-only`（只应用了参数）/ `none`（这套皮肤没有背景）。
     */
    const applySkinBackground = useCallback(
        async (skin: ThemeSkin): Promise<'applied' | 'options-only' | 'none'> => {
            const hint = readSkinBackgroundHint(skin.background);
            if (!hint) return 'none';

            const id = skinBackgroundAssetId(skin.id);
            const options = mergeSkinBackgroundOptions(hint, current);

            if (hint.kind === 'web') {
                const html = await backgroundService.loadWeb(id);
                if (!html) {
                    // 素材缺失：只把参数套上去，背景类型保持用户当前的选择
                    setBackgroundOptions(options);
                    return 'options-only';
                }
                setBackgroundKind('web');
                setBackgroundWeb({id, name: hint.file ?? `${skin.id}.html`, size: html.length});
                setBackgroundOptions(options);
                setBackgroundEnabled(true);
                return 'applied';
            }

            const blob = await backgroundService.load(id);
            if (!blob) {
                setBackgroundOptions(options);
                return 'options-only';
            }
            setBackgroundKind('video');
            setBackgroundAsset({
                id,
                name: hint.file ?? `${skin.id}.mp4`,
                size: blob.size,
                type: blob.type,
                importedAt: Date.now(),
            });
            setBackgroundOptions(options);
            setBackgroundEnabled(true);
            return 'applied';
        },
        [
            current,
            setBackgroundAsset,
            setBackgroundEnabled,
            setBackgroundKind,
            setBackgroundOptions,
            setBackgroundWeb,
        ],
    );

    return {bindSkinBackground, applySkinBackground};
}

export default useSkinBackground;
