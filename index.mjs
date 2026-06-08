import 加密模块 from 'node:crypto';
import 文件系统 from 'node:fs';
import 路径模块 from 'node:path';

export const info = {
    id: 'lwcs-archive',
    name: 'LWCS Archive',
    description: 'LWCS cold archive storage backend.',
};

const 插件名 = 'lwcs-archive';
const 配置文件名 = 'lwcs_archive_config.json';
const 默认归档目录名 = 'lwcs_archive';
const 最大Json字节 = 64 * 1024 * 1024;

function 文本(值) {
    return 值 === undefined || 值 === null ? '' : String(值);
}

function 对象(值) {
    return 值 && typeof 值 === 'object' && !Array.isArray(值) ? 值 : {};
}

function 规范化路径段(值, 兜底 = 'default') {
    const 原文 = 文本(值).trim();
    const 安全段 = 原文.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    return (安全段 || 兜底).slice(0, 96) || 兜底;
}

function 确保目录(目录路径) {
    文件系统.mkdirSync(目录路径, { recursive: true });
    return 目录路径;
}

function 写文本原子(文件路径, 文本内容) {
    确保目录(路径模块.dirname(文件路径));
    const 临时路径 = `${文件路径}.${process.pid}.${Date.now()}.${加密模块.randomBytes(4).toString('hex')}.tmp`;
    文件系统.writeFileSync(临时路径, 文本内容, 'utf8');
    文件系统.renameSync(临时路径, 文件路径);
}

function 读Json(文件路径, 兜底) {
    if (!文件系统.existsSync(文件路径)) return 兜底;
    return JSON.parse(文件系统.readFileSync(文件路径, 'utf8'));
}

function 取用户根目录(请求) {
    const 根目录 = 请求.user?.directories?.root;
    if (!根目录) throw new Error('user_root_missing');
    return 根目录;
}

function 取配置路径(请求) {
    return 路径模块.join(取用户根目录(请求), 配置文件名);
}

function 读配置(请求) {
    try {
        const 原始配置 = 读Json(取配置路径(请求), null);
        const 配置 = 对象(原始配置);
        return {
            version: 1,
            customRoot: 文本(配置.customRoot).trim(),
            updatedAt: 文本(配置.updatedAt).trim(),
        };
    } catch (错误) {
        console.warn(`[${插件名}] 配置读取失败`, 错误);
        return { version: 1, customRoot: '', updatedAt: '' };
    }
}

function 写配置(请求, 配置) {
    const 下一配置 = {
        version: 1,
        customRoot: 文本(配置.customRoot).trim(),
        updatedAt: new Date().toISOString(),
    };
    写文本原子(取配置路径(请求), JSON.stringify(下一配置, null, 2));
    return 下一配置;
}

function 取用户标识(请求) {
    return 规范化路径段(请求.user?.profile?.handle || 'default-user', 'default-user');
}

function 取默认归档根目录(请求) {
    return 路径模块.resolve(取用户根目录(请求), '..', '..', '..', 默认归档目录名);
}

function 计算归档根目录(请求, 配置 = 读配置(请求)) {
    const 自定义根目录 = 文本(配置.customRoot).trim();
    if (自定义根目录) {
        return {
            root: 路径模块.resolve(自定义根目录, 取用户标识(请求)),
            config: 配置,
            custom: true,
        };
    }
    return {
        root: 路径模块.resolve(取默认归档根目录(请求), 取用户标识(请求)),
        config: 配置,
        custom: false,
    };
}

function 路径在根目录内(根目录, 目标路径) {
    const 相对路径 = 路径模块.relative(根目录, 目标路径);
    return 相对路径 === '' || (!!相对路径 && !相对路径.startsWith('..') && !路径模块.isAbsolute(相对路径));
}

function 解析Json文件路径(请求, 相对路径输入) {
    const 根目录信息 = 计算归档根目录(请求);
    const 原始路径 = 文本(相对路径输入).replace(/\\/g, '/').trim();
    if (!原始路径) throw new Error('path_required');
    if (原始路径.startsWith('/') || 原始路径.includes('\u0000')) throw new Error('invalid_path');
    const 路径段列表 = 原始路径.split('/').filter(Boolean);
    if (!路径段列表.length || 路径段列表.some(路径段 => 路径段 === '.' || 路径段 === '..')) throw new Error('invalid_path');
    if (!路径段列表[路径段列表.length - 1].endsWith('.json')) throw new Error('json_only');
    const 文件路径 = 路径模块.resolve(根目录信息.root, ...路径段列表);
    if (!路径在根目录内(根目录信息.root, 文件路径)) throw new Error('path_escape');
    return { ...根目录信息, relativePath: 路径段列表.join('/'), filePath: 文件路径 };
}

function 计算校验(文本内容) {
    return 加密模块.createHash('sha256').update(文本内容, 'utf8').digest('hex');
}

function 检查用户(请求, 响应) {
    if (!请求.user?.directories?.root) {
        响应.sendStatus(403);
        return false;
    }
    return true;
}

function 发送错误(响应, 错误, 兜底 = 'archive_error') {
    const 错误码 = 文本(错误?.message).trim() || 兜底;
    const 状态码 = 错误码 === 'not_found'
        ? 404
        : ['path_required', 'invalid_path', 'json_only', 'path_escape', 'invalid_json', 'payload_too_large', 'custom_root_not_allowed'].includes(错误码)
            ? 400
            : 错误码 === 'admin_required'
                ? 403
                : 500;
    if (状态码 >= 500) console.error(`[${插件名}]`, 错误);
    return 响应.status(状态码).send({ ok: false, error: 错误码 });
}

function 检查可写目录(目录路径) {
    确保目录(目录路径);
    for (const 文件名 of 文件系统.readdirSync(目录路径)) {
        if (文件名.startsWith('.write-test-') && 文件名.endsWith('.tmp')) {
            文件系统.rmSync(路径模块.join(目录路径, 文件名), { force: true });
        }
    }
    const 测试路径 = 路径模块.join(目录路径, `.write-test-${process.pid}-${Date.now()}.tmp`);
    try {
        文件系统.writeFileSync(测试路径, 'ok', 'utf8');
    } finally {
        文件系统.rmSync(测试路径, { force: true });
    }
}

export async function init(路由器) {
    路由器.post('/status', (请求, 响应) => {
        if (!检查用户(请求, 响应)) return;
        try {
            const 根目录信息 = 计算归档根目录(请求);
            let 可写 = true;
            let 错误文本 = '';
            try {
                检查可写目录(根目录信息.root);
            } catch (写入错误) {
                可写 = false;
                错误文本 = 文本(写入错误?.message || 写入错误);
            }
            return 响应.send({
                ok: true,
                enabled: true,
                writable: 可写,
                root: 根目录信息.root,
                custom: 根目录信息.custom,
                config: 根目录信息.config,
                admin: !!请求.user?.profile?.admin,
                error: 错误文本,
            });
        } catch (错误) {
            return 发送错误(响应, 错误, 'status_failed');
        }
    });

    路由器.post('/config/get', (请求, 响应) => {
        if (!检查用户(请求, 响应)) return;
        try {
            const 根目录信息 = 计算归档根目录(请求);
            return 响应.send({
                ok: true,
                root: 根目录信息.root,
                custom: 根目录信息.custom,
                config: 根目录信息.config,
            });
        } catch (错误) {
            return 发送错误(响应, 错误, 'config_read_failed');
        }
    });

    路由器.post('/config/set', (请求, 响应) => {
        if (!检查用户(请求, 响应)) return;
        try {
            if (!请求.user?.profile?.admin) throw new Error('admin_required');
            const 自定义根目录 = 文本(请求.body?.customRoot).trim();
            if (自定义根目录 && !路径模块.isAbsolute(自定义根目录)) throw new Error('invalid_path');
            const 待写配置 = { version: 1, customRoot: 自定义根目录, updatedAt: new Date().toISOString() };
            const 根目录信息 = 计算归档根目录(请求, 待写配置);
            检查可写目录(根目录信息.root);
            const 配置 = 写配置(请求, 待写配置);
            return 响应.send({
                ok: true,
                root: 根目录信息.root,
                custom: 根目录信息.custom,
                config: 配置,
            });
        } catch (错误) {
            return 发送错误(响应, 错误, 'config_write_failed');
        }
    });

    路由器.post('/json/read', (请求, 响应) => {
        if (!检查用户(请求, 响应)) return;
        try {
            const 目标 = 解析Json文件路径(请求, 请求.body?.path);
            if (!文件系统.existsSync(目标.filePath)) throw new Error('not_found');
            const 数据 = 读Json(目标.filePath, null);
            return 响应.send({ ok: true, path: 目标.relativePath, data: 数据 });
        } catch (错误) {
            return 发送错误(响应, 错误, 'json_read_failed');
        }
    });

    路由器.post('/json/write', (请求, 响应) => {
        if (!检查用户(请求, 响应)) return;
        try {
            const 目标 = 解析Json文件路径(请求, 请求.body?.path);
            const Json文本 = JSON.stringify(请求.body?.data ?? null);
            const 字节数 = Buffer.byteLength(Json文本, 'utf8');
            if (字节数 > 最大Json字节) throw new Error('payload_too_large');
            写文本原子(目标.filePath, Json文本);
            return 响应.send({
                ok: true,
                path: 目标.relativePath,
                checksum: 计算校验(Json文本),
                byteSize: 字节数,
            });
        } catch (错误) {
            return 发送错误(响应, 错误, 'json_write_failed');
        }
    });

    路由器.post('/json/delete', (请求, 响应) => {
        if (!检查用户(请求, 响应)) return;
        try {
            const 目标 = 解析Json文件路径(请求, 请求.body?.path);
            if (文件系统.existsSync(目标.filePath)) 文件系统.unlinkSync(目标.filePath);
            return 响应.send({ ok: true, path: 目标.relativePath });
        } catch (错误) {
            return 发送错误(响应, 错误, 'json_delete_failed');
        }
    });
}
