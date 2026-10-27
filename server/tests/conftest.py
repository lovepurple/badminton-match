"""测试会话统一使用临时数据库，避免各测试文件互相覆盖环境变量。"""

import os
import tempfile

os.environ.setdefault(
    "GORILLA_DB", os.path.join(tempfile.mkdtemp(prefix="gorilla-test-"), "test.db")
)
# 测试里的管理员账号（真实部署可用同一变量指定）
os.environ.setdefault("GORILLA_ADMIN_DEVICES", "venue-admin")
