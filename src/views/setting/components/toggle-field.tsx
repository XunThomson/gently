import {useTranslation} from 'react-i18next';
import {UnderlineRadioGroup} from '../../../components/ui/radio-group';
import {isMobilePlatform} from '../../../utils/platform';
import {Field} from './field';
import settings from '../setting.module.css';

export interface ToggleFieldProps {
    label: string;
    hint?: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}

/**
 * 设置里的开关行（R144 移动适配）。
 *
 * 桌面沿用「启用 / 禁用」行内单选；手机用**原生开关行**（整行可点、role=switch），
 * 与安卓设置一致，不再把两个单选文字塞进行尾。
 */
export function ToggleField({label, hint, checked, onChange}: ToggleFieldProps) {
    const {t} = useTranslation();
    const mobile = isMobilePlatform();

    if (!mobile) {
        return (
            <Field label={label} hint={hint}>
                <UnderlineRadioGroup
                    name={`toggle-${label}`}
                    value={checked ? 'on' : 'off'}
                    onChange={(value) => onChange(value === 'on')}
                    options={[
                        {value: 'on', label: t('common.enable')},
                        {value: 'off', label: t('common.disable')},
                    ]}
                />
            </Field>
        );
    }

    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            className={settings.row}
            onClick={() => onChange(!checked)}
        >
            <span className={settings.rowText}>
                <span className={settings.rowLabel}>{label}</span>
                {hint && <span className={settings.rowHint}>{hint}</span>}
            </span>
            <span className={settings.switch} data-on={checked} aria-hidden="true">
                <i className={settings.switchKnob}/>
            </span>
        </button>
    );
}

export default ToggleField;
