import {useContext} from 'react';
import {useTranslation} from 'react-i18next';
import {ActionsCell, type RowAction} from '../data-table';
import {IconMore} from '../icon';
import {RowActionsContext} from './RowActionsProvider';
import styles from './RowActions.module.css';

export interface MobileRowActionsProps {
    /** 面板标题（曲目名 / 插件名）：手机上没有表头，面板第一行要说明这行是谁 */
    title: string;
    actions: RowAction[];
}

/**
 * 手机列表行尾的 ⋯：把行内那一排小按钮收进底部操作面板。
 *
 * 动作本身与桌面**完全同源**（都来自 `useTrackActions` / 视图自己的那段），
 * 这里只换承载方式：三个字的小按钮在 360px 宽下会挤成两行、还点不准，
 * 而 ⋯ + 底部面板每一项都有 48px 的触控高度。
 */
export function MobileRowActions({title, actions}: MobileRowActionsProps) {
    const {t} = useTranslation();
    const sheet = useContext(RowActionsContext);

    /* 没有面板宿主（桌面端 / 冒烟里直接渲染表格）→ 退回行内按钮，不留「点了没反应」的入口 */
    if (!sheet) return <ActionsCell actions={actions}/>;

    return (
        <button
            type="button"
            className={styles.trigger}
            aria-label={t('mobile.actionsFor', {name: title})}
            aria-haspopup="dialog"
            onClick={(event) => {
                /* 行本身是「播放 / 切歌」的点击区：⋯ 不能顺手把歌切了 */
                event.stopPropagation();
                sheet.open({title, actions});
            }}
        >
            <IconMore size={18}/>
        </button>
    );
}

export default MobileRowActions;
