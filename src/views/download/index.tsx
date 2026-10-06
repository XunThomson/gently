import {Outlet, useLocation, useNavigate} from 'react-router';
import {useTranslation} from 'react-i18next';
import {Page} from '../../components/ui/page';
import {UnderlineRadioGroup} from '../../components/ui/radio-group';

/**
 * 下载管理：Tab 与子路由一一对应。
 *
 * 选中态直接由 URL 推导（不再用 <Navigate> 重定向），
 * 因此不会出现「进入页面时 tab 闪烁」的问题。
 */
export default function DownloadView() {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const {pathname} = useLocation();

    const selected = pathname.endsWith('/downloading') ? 'downloading' : 'downloaded';

    const options = [
        {label: t('page.download.downloading'), value: 'downloading'},
        {label: t('page.download.downloaded'), value: 'downloaded'},
    ];

    return (
        <Page
            title={t('page.download.title')}
            toolbar={
                <UnderlineRadioGroup
                    name="download"
                    options={options}
                    value={selected}
                    onChange={(value) => navigate(`/download/${value}`)}
                />
            }
        >
            <Outlet/>
        </Page>
    );
}
