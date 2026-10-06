import UnderlineRadioBtn from "../../components/radiobtn/UnderlineRadioBtn/UnderlineRadioBtn.tsx";
import styles from './download.module.css'
import {useTranslation} from "react-i18next";
import {Outlet, useLocation, useNavigate} from "react-router";

export default function DownloadView() {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();

    // 根据当前 URL 反推选中的 tab（保证刷新/直接访问子路由时 tab 状态正确）
    // bug: 由于重定向问题，目前效果为进入页面时tab闪烁切换 待解决
    const selectedTech = location.pathname.endsWith("downloaded")
        ? "downloaded"
        : "downloading";

    // onChange：跳转到对应子路由
    const intercutView = (curr: string) => {
        navigate(curr, {relative: "route"});
    };

    const techOptions = [
        {label: t("page.download.downloading"), value: "downloading"},
        {label: t("page.download.downloaded"), value: "downloaded"},
    ];

    return (
        <div className={"view-container flex flex-col"}>
            <div className={styles.header}>
                <div className={`${styles.select_tab} mb-2`}>
                    <UnderlineRadioBtn
                        name="download"
                        options={techOptions}
                        value={selectedTech}
                        onChange={intercutView}
                    />
                </div>
            </div>
            <div className={styles.list_container}>
                {/* 子路由出口：downloading_view / downloaded_view */}
                <Outlet/>
            </div>
        </div>
    );
}