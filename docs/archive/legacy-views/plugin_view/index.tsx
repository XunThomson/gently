import UnderlineRadioBtn from "../../components/radiobtn/UnderlineRadioBtn/UnderlineRadioBtn.tsx";
import {DataTable} from "../../components/table/DataTable";

export default function PluginView() {

    const pluginColumns = [
        { key: 'index', title: '#' },
        { key: 'source', title: '来源' },
        { key: 'version', title: '版本号' },
        { key: 'author', title: '作者' },
        {
            key: 'actions',
            title: '操作',
            render: () => (
                <div>
                    <button className="actionBtn btnDanger">卸载</button>
                    <button className="actionBtn btnPrimary">更新</button>
                </div>
            )
        },
    ];

    return (
        <div className="plugin-view">
            <DataTable columns={pluginColumns} dataSource={[]} rowKey="id" />
        </div>
    );
}