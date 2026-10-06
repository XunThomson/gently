import {ColumnDef, DataTable} from "../../../components/table/DataTable";

export default function DownloadedView() {
    const musicColumns: ColumnDef<any>[] = [
        { key: 'index', title: '#', width: '50px', align: 'center' },
        {
            key: 'title',
            title: '标题',
            width: 'minmax(250px, 1.5fr)',
            render: (val, record) => <span style={{ color: record.isActive ? '#fff' : '#e0e0e0' }}>{val}</span>
        },
        { key: 'author', title: '作者', width: '1fr' },
        { key: 'album', title: '专辑', width: '1fr' },
        { key: 'duration', title: '时长', width: '80px', align: 'center' },
        {
            key: 'source',
            title: '来源',
            width: '100px',
            render: (val) => <span className="badge">{val}</span>
        },
    ];

    const musicData = [
        { id: 1, index: 1, title: '【探窗】开口跪！...', author: '共青团中央', album: 'BV1dL411M7Se', duration: '03:11', source: 'bilibili', isActive: true },
        { id: 2, index: 2, title: '【Hi-Res无损】《伯虎说》...', author: '心刚音乐库', album: 'BV1KYYTegE3K', duration: '03:39', source: 'bilibili' },
    ];
    return (
        <div className={"flex flex-col"}>
            <DataTable columns={musicColumns} dataSource={musicData} rowKey="id" />
        </div>
    );
}