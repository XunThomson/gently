import {useTranslation} from 'react-i18next';
import {useActions, useSelect} from '../../../store';
import {ToggleField} from './toggle-field';

/**
 * 设置页的宠物开关（R145 收敛）。
 *
 * 用户明确要求：设置里的宠物配置**只保留启用项**。锁定、大小、走动、安装包
 * 这些都已经收进宠物自己的控制面板（独立窗口，后续接入），不再在设置页重复一份，
 * 避免「设置里改一次、面板里又改一次」的双入口。
 */
export function PetCard() {
    const {t} = useTranslation();
    const enabled = useSelect((state) => state.ui.petEnabled);
    const {setPetEnabled} = useActions().ui;

    return (
        <ToggleField
            label={t('page.setting.petToggle')}
            hint={t('page.setting.petHint')}
            checked={enabled}
            onChange={setPetEnabled}
        />
    );
}

export default PetCard;
