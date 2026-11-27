"""CLASSIFYING acceptance (``document_contract.md`` "Processing"): seven HCM-UTE documents.

A small published taxonomy mirrors the seed fixtures (vn-university template
schemes, HCM-UTE domain / org-unit / program and their rules). Every document
goes through ``ItemIngestionService.process_document`` with one run plan; the
model is a scripted fake that answers each document by looking the labels up
in the prompt it receives. The deterministic part (document type by pattern,
``implies`` rules, metadata, shortlists, the shared prompt prefix) is checked
for real; the final domain choice is the script's.
"""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass, field
from datetime import date
from types import SimpleNamespace
from typing import Any
from uuid import UUID

import pytest
from docling_core.types.doc import DocItemLabel, DoclingDocument
from sqlalchemy import select, text

from bomesh.db.engine import transaction_scope
from bomesh.db.models import (
    Concept,
    ConceptScheme,
    DocumentApplicability,
    DocumentProfile,
    Item,
    ItemClassification,
    ItemConcept,
    ItemRevision,
)
from bomesh.document_index import ItemIndex, SemanticContextualizer
from bomesh.document_structure import StructureManifest, StructureRef
from bomesh.runtime import AppRuntime
from bomesh.services.ingestion.run_engine import RunClassification
from bomesh.services.knowledge_items.indexing import ItemIngestionService
from bomesh.services.knowledge_items.structure_store import ParsedStructure
from bomesh.services.taxonomy.classification import (
    ClassificationPlan,
    DocumentInput,
    prepare,
    route,
)
from harness import Fakes, Sessions, World
from taxonomy_support import C, R, S, Taxonomy, seed_taxonomy

pytestmark = pytest.mark.asyncio

# -- Taxonomy (rows copied from backend/script/seed_fixtures) --------------------

_DOMAIN = (
    C('it', 'Công nghệ thông tin & Dữ liệu', alt=('CNTT', 'công nghệ thông tin', 'khoa học máy tính'), mappings=(('isced-f-2013', '061', 'close'),)),
    C('it-lap-trinh', 'Lập trình cơ bản & kỹ thuật lập trình', alt=('lập trình', 'nhập môn lập trình', 'ngôn ngữ C', 'kỹ thuật lập trình', 'con trỏ', 'hàm', 'đệ quy'), broader=('it',)),
    C('it-ctdl-giai-thuat', 'Cấu trúc dữ liệu & giải thuật', alt=('cấu trúc dữ liệu', 'giải thuật', 'thuật toán', 'phân tích thiết kế giải thuật', 'độ phức tạp', 'sắp xếp', 'đồ thị', 'cây nhị phân', 'quy hoạch động'), broader=('it',)),
    C('it-csdl', 'Cơ sở dữ liệu & hệ quản trị CSDL', alt=('cơ sở dữ liệu', 'SQL', 'hệ quản trị cơ sở dữ liệu', 'thiết kế CSDL', 'chuẩn hóa', 'MySQL', 'NoSQL', 'DBMS'), broader=('it',)),
    C('it-cong-nghe-phan-mem', 'Công nghệ phần mềm & phân tích thiết kế hệ thống', alt=('công nghệ phần mềm', 'phân tích thiết kế hệ thống', 'UML', 'yêu cầu phần mềm', 'quản lý dự án phần mềm', 'kiến trúc phần mềm'), broader=('it',)),
    C('it-ai', 'Trí tuệ nhân tạo & học máy', alt=('AI & học máy', 'Trí tuệ nhân tạo', 'Học máy & học sâu', 'AI', 'tìm kiếm heuristic', 'hệ chuyên gia', 'biểu diễn tri thức', 'suy diễn', 'logic mờ', 'học máy', 'học sâu', 'mạng nơ-ron', 'CNN', 'RNN', 'LLM', 'phân lớp', 'ML'), broader=('it',)),
    C('it-thi-giac-may-tinh', 'Thị giác máy tính & xử lý ảnh', alt=('nhận diện khuôn mặt', 'nhận diện đối tượng', 'thị giác máy tính', 'xử lý ảnh', 'nhận dạng khuôn mặt', 'phát hiện đối tượng', 'YOLO', 'phân đoạn ảnh', 'nhận dạng biển số'), broader=('it-ai',)),
    C('it-xu-ly-ngon-ngu-tu-nhien', 'Xử lý ngôn ngữ tự nhiên', alt=('NLP', 'phân tích cảm xúc', 'tóm tắt văn bản', 'tìm kiếm ngữ nghĩa', 'RAG', 'nhận dạng tiếng nói'), broader=('it-ai',)),
    C('it-khdl', 'Khoa học & kỹ thuật dữ liệu', alt=('KH&KT dữ liệu', 'khoa học dữ liệu', 'kỹ thuật dữ liệu', 'khai phá dữ liệu', 'dữ liệu lớn', 'kho dữ liệu', 'ETL', 'trực quan hóa dữ liệu'), broader=('it',)),
    C('it-dien-toan-dam-may', 'Điện toán đám mây & DevOps', alt=('điện toán đám mây', 'AWS', 'ảo hóa', 'CI/CD', 'hệ thống phân tán'), broader=('it',)),
    C('it-an-toan-thong-tin', 'An toàn thông tin & mật mã', alt=('an toàn thông tin', 'bảo mật', 'mật mã', 'mã hóa', 'RSA', 'AES', 'tấn công mạng', 'mã độc', 'kiểm thử xâm nhập', 'pháp chứng số'), broader=('it',)),
    C('it-mang', 'Mạng máy tính & quản trị hệ thống', alt=('Nền tảng mạng máy tính', 'mạng máy tính', 'mô hình OSI', 'TCP/IP', 'giao thức', 'thiết bị mạng', 'cáp mạng', 'truyền dẫn'), broader=('it',)),
    C('ee', 'Điện – Điện tử – Tự động hóa', alt=('điện – điện tử', 'điện tử'), mappings=(('isced-f-2013', '0713', 'close'), ('isced-f-2013', '0714', 'close'))),
    C('ee-ky-thuat-dien', 'Kỹ thuật điện', broader=('ee',)),
    C('ee-he-thong-dien', 'Hệ thống điện & lưới điện', alt=('hệ thống điện', 'lưới điện', 'truyền tải', 'bảo vệ rơ le', 'ổn định hệ thống điện', 'trạm biến áp', 'ETAP', 'PSS/E'), broader=('ee-ky-thuat-dien',)),
    C('ee-dien-tu-cong-suat', 'Điện tử công suất', alt=('chỉnh lưu', 'nghịch lưu', 'biến tần', 'DC-DC', 'IGBT', 'MOSFET công suất', 'nguồn xung'), broader=('ee-ky-thuat-dien',)),
    C('ee-tu-dong-hoa', 'Điều khiển & tự động hóa', alt=('tự động hóa',), broader=('ee',)),
    C('ee-ly-thuyet-dieu-khien', 'Lý thuyết điều khiển tự động', alt=('điều khiển tự động', 'PID', 'điều khiển mờ', 'điều khiển thích nghi', 'điều khiển phi tuyến', 'LQR', 'nhận dạng hệ thống'), broader=('ee-tu-dong-hoa',)),
    C('ee-dien-tu', 'Điện tử & vi mạch', broader=('ee',)),
    C('ee-vi-xu-ly', 'Vi xử lý & vi điều khiển', alt=('vi xử lý', 'vi điều khiển', 'PIC', 'AVR', 'STM32', 'ARM', 'lập trình nhúng C', 'ngắt'), broader=('ee-dien-tu',)),
    C('ve', 'Ô tô, Nhiệt & Năng lượng', alt=('năng lượng', 'động lực'), mappings=(('isced-f-2013', '0716', 'close'), ('isced-f-2013', '0713', 'close'))),
    C('ve-o-to', 'Kỹ thuật ô tô', alt=('ô tô', 'công nghệ ô tô'), broader=('ve',)),
    C('ve-ky-thuat-nhiet', 'Kỹ thuật nhiệt & truyền nhiệt', alt=('nhiệt động học', 'truyền nhiệt', 'lò hơi', 'thiết bị trao đổi nhiệt', 'sấy', 'thu hồi nhiệt', 'CFD', 'tuabin'), broader=('ve',)),
    C('ve-nang-luong-tai-tao', 'Năng lượng tái tạo & năng lượng mới', alt=('năng lượng tái tạo', 'điện mặt trời', 'pin mặt trời', 'điện gió', 'sinh khối', 'lưu trữ năng lượng', 'năng lượng sạch'), broader=('ve',)),
    C('ve-hieu-qua-nang-luong', 'Hiệu quả & kiểm toán năng lượng', alt=('tiết kiệm năng lượng', 'kiểm toán năng lượng', 'hiệu suất năng lượng', 'quản lý năng lượng', 'tòa nhà xanh'), broader=('ve',)),
)

_FUNCTION = (
    C('ts', 'Tuyển sinh', alt=('công tác tuyển sinh',)),
    C('ts-dai-hoc', 'Tuyển sinh đại học', alt=('xét tuyển đại học', 'điểm chuẩn', 'xét tuyển', 'chỉ tiêu', 'tổ hợp xét tuyển', 'học bạ', 'đánh giá năng lực', 'nhập học', 'đề án tuyển sinh', 'mã ngành'), broader=('ts',)),
    C('ts-sau-dai-hoc', 'Tuyển sinh sau đại học', alt=('tuyển sinh thạc sĩ', 'tuyển sinh tiến sĩ', 'xét tuyển cao học', 'hồ sơ dự tuyển sau đại học'), broader=('ts',)),
    C('dt', 'Đào tạo', alt=('quản lý đào tạo', 'công tác đào tạo')),
    C('dt-ctdt', 'Chương trình đào tạo & chuẩn đầu ra', alt=('CTĐT & CĐR', 'chương trình đào tạo', 'CTĐT', 'chuẩn đầu ra', 'CĐR', 'chương trình chất lượng cao', 'chất lượng cao', 'chương trình tiên tiến', 'liên kết đào tạo quốc tế', 'ma trận chuẩn đầu ra', 'CDIO', 'liên kết quốc tế', 'dạy học bằng tiếng Anh'), broader=('dt',)),
    C('dt-thi', 'Thi & đánh giá kết quả học tập', alt=('thi & đánh giá', 'thi cử', 'lịch thi', 'tổ chức thi', 'điểm thi', 'phúc khảo', 'quy chế thi', 'kết quả học tập', 'điểm trung bình', 'GPA'), broader=('dt',)),
    C('dt-do-an', 'Thực tập, đồ án & khóa luận', alt=('khóa luận', 'đồ án', 'thực tập', 'khóa luận tốt nghiệp', 'đồ án tốt nghiệp', 'đồ án & khóa luận', 'thực tập tốt nghiệp', 'kiến tập', 'đào tạo tại doanh nghiệp', 'hợp tác doanh nghiệp đào tạo'), broader=('dt',)),
    C('dt-tot-nghiep', 'Tốt nghiệp & văn bằng', alt=('tốt nghiệp', 'cấp bằng', 'xét tốt nghiệp', 'văn bằng', 'chứng chỉ', 'lễ tốt nghiệp', 'bảng điểm'), broader=('dt',)),
    C('dt-sau-dai-hoc', 'Đào tạo sau đại học', alt=('NCS', 'sau đại học', 'thạc sĩ', 'tiến sĩ', 'cao học', 'nghiên cứu sinh', 'bảo vệ luận án', 'PhD'), broader=('dt',)),
    C('dt-hoc-lieu', 'Học liệu & giảng dạy', alt=('học liệu', 'học liệu số', 'giảng dạy', 'biên soạn giáo trình', 'thẩm định giáo trình', 'xuất bản', 'nhà xuất bản', 'học liệu mở', 'OER', 'bài giảng số', 'video bài giảng'), broader=('dt',)),
    C('sv', 'Công tác sinh viên', alt=('CTSV', 'công tác người học')),
    C('sv-hoc-bong', 'Học bổng & hỗ trợ', alt=('hỗ trợ người học', 'trợ cấp xã hội', 'học bổng', 'học bổng khuyến khích học tập', 'học bổng tài năng', 'học bổng doanh nghiệp', 'xét học bổng', 'trợ cấp', 'vay vốn sinh viên', 'hoàn cảnh khó khăn'), broader=('sv',)),
    C('mien-giam-hoc-phi', 'Miễn, giảm học phí', alt=('miễn giảm HP', 'miễn học phí', 'giảm học phí', 'miễn giảm học phí'), broader=('tc', 'sv')),
    C('sv-ktx', 'Ký túc xá & đời sống sinh viên', alt=('khai báo ngoại trú', 'BHYT sinh viên', 'bảo hiểm y tế', 'ký túc xá', 'KTX', 'nhà trọ', 'y tế học đường', 'căng tin', 'đời sống sinh viên', 'nội trú', 'ngoại trú'), broader=('sv',)),
    C('tc', 'Kế hoạch – Tài chính', alt=('tài chính', 'kế hoạch tài chính')),
    C('tc-hoc-phi', 'Học phí', alt=('mức học phí', 'nộp học phí', 'lệ phí'), broader=('tc',)),
    C('kh', 'Khoa học & Công nghệ', alt=('KH&CN', 'khoa học công nghệ', 'quản lý khoa học')),
    C('kh-cong-bo', 'Công bố khoa học', alt=('hội thảo khoa học', 'tạp chí', 'công bố quốc tế', 'tạp chí khoa học', 'kỷ yếu hội thảo', 'hội nghị khoa học', 'ISI'), broader=('kh',)),
    C('kh-de-tai', 'Đề tài nghiên cứu', alt=('đề tài khoa học', 'nhiệm vụ khoa học công nghệ', 'đề tài cấp trường', 'đề tài cấp bộ', 'nghiệm thu', 'thuyết minh đề tài', 'kinh phí nghiên cứu'), broader=('kh',)),
)

_DOCUMENT_TYPE = (
    C('quy-che', 'Quy chế', match_patterns=('/QC-', '(?i)^\\s*quy chế', '(?i)^\\s*qui chế')),
    C('quy-dinh', 'Quy định', match_patterns=('/QyĐ-', '(?i)^\\s*quy định', '(?i)^\\s*qui định')),
    C('quyet-dinh', 'Quyết định', alt=('QĐ',), match_patterns=('/QĐ-', '(?i)^\\s*quyết định')),
    C('huong-dan', 'Hướng dẫn', alt=('HD', 'văn bản hướng dẫn'), match_patterns=('/HD-', '(?i)^\\s*hướng dẫn')),
    C('ke-hoach', 'Kế hoạch', alt=('KH',), match_patterns=('/KH-', '(?i)^\\s*kế hoạch')),
    C('thong-bao', 'Thông báo', alt=('TB',), hidden=('hạn nộp',), match_patterns=('/TB-', '(?i)^\\s*thông báo')),
    C('chuong-trinh-dao-tao', 'Chương trình đào tạo', alt=('CTĐT', 'khung chương trình', 'bản mô tả chương trình đào tạo'), match_patterns=('(?i)^\\s*chương trình đào tạo', '(?i)^\\s*bản mô tả chương trình', '(?i)^\\s*khung chương trình')),
    C('de-cuong-hoc-phan', 'Đề cương học phần', alt=('đề cương chi tiết', 'đề cương môn học'), match_patterns=('(?i)^\\s*đề cương (chi tiết )?học phần', '(?i)^\\s*đề cương (chi tiết )?môn học', '(?i)^\\s*syllabus')),
    C('giao-trinh', 'Giáo trình – bài giảng', alt=('giáo trình', 'bài giảng', 'tài liệu học tập', 'slide bài giảng'), match_patterns=('(?i)^\\s*giáo trình', '(?i)^\\s*bài giảng')),
    C('de-thi', 'Đề thi', alt=('đề kiểm tra', 'đáp án đề thi'), match_patterns=('(?i)^\\s*đề thi', '(?i)^\\s*đề kiểm tra')),
    C('bai-bao', 'Bài báo', alt=('bài báo khoa học', 'bài báo hội nghị'), match_patterns=('(?i)doi\\.org/10\\.', '(?i)^\\s*abstract\\b')),
    C('luan-van', 'Luận văn – luận án', alt=('luận văn', 'luận án', 'luận văn thạc sĩ', 'luận án tiến sĩ'), match_patterns=('(?i)^\\s*luận văn', '(?i)^\\s*luận án', '(?i)^\\s*tóm tắt luận văn', '(?i)^\\s*tóm tắt luận án')),
    C('do-an', 'Đồ án – khóa luận', alt=('khóa luận', 'đồ án', 'đồ án tốt nghiệp', 'khóa luận tốt nghiệp', 'báo cáo thực tập'), match_patterns=('(?i)^\\s*đồ án', '(?i)^\\s*khóa luận', '(?i)^\\s*khoá luận')),
)

_AUDIENCE = (
    C('thi-sinh', 'Thí sinh', alt=('thí sinh dự tuyển', 'học sinh THPT', 'người dự tuyển')),
    C('sinh-vien', 'Sinh viên đại học', alt=('sinh viên', 'SV', 'tân sinh viên', 'SV ĐH')),
    C('hoc-vien-sau-dai-hoc', 'Học viên/NCS sau đại học', alt=('học viên cao học', 'nghiên cứu sinh', 'NCS', 'học viên sau đại học')),
    C('nguoi-hoc-khong-chinh-quy', 'Người học VLVH/liên thông', alt=('người học vừa làm vừa học', 'sinh viên liên thông', 'sinh viên văn bằng 2')),
    C('giang-vien', 'Giảng viên', alt=('GV', 'cán bộ giảng dạy', 'nhà nghiên cứu', 'nghiên cứu viên')),
    C('can-bo-vien-chuc', 'Cán bộ – viên chức', alt=('viên chức', 'CBVC', 'người lao động', 'cán bộ', 'nhân viên')),
    C('doanh-nghiep-doi-tac', 'Doanh nghiệp & đối tác', alt=('doanh nghiệp', 'nhà tuyển dụng', 'đối tác')),
    C('cong-chung', 'Công chúng', alt=('cộng đồng', 'người dân', 'báo chí')),
)

_ORG_UNIT = (
    C('truong', 'Trường Đại học Công nghệ Kỹ thuật TP.HCM', alt=('Trường ĐH Công nghệ Kỹ thuật TP.HCM', 'Trường Đại học Công nghệ Kỹ thuật Thành phố Hồ Chí Minh', 'ĐHCNKT', 'Trường Đại học Sư phạm Kỹ thuật TP.HCM', 'Trường ĐH Sư phạm Kỹ thuật TP.HCM', 'ĐHSPKT', 'Ban Giám hiệu', 'Hiệu trưởng')),
    C('khoa-cntt', 'Khoa Công nghệ Thông tin', alt=('CNTT', 'Khoa CNTT')),
    C('khoa-dien-dien-tu', 'Khoa Điện – Điện tử', alt=('Khoa Điện - Điện tử', 'Khoa Điện Điện tử', 'Khoa Điện')),
    C('khoa-giao-thong-nang-luong', 'Khoa Giao thông và Năng lượng', alt=('GT&NL', 'K.GTNL', 'Khoa Cơ khí Động lực')),
    C('vien-sau-dai-hoc', 'Viện Sau đại học', alt=('Viện SĐH',)),
    C('phong-dao-tao', 'Phòng Đào tạo', alt=('ĐT', 'PĐT', 'P.ĐT', 'Phòng Đào tạo - Vừa làm vừa học')),
    C('phong-ctsv', 'Phòng Công tác Sinh viên', alt=('CTSV', 'Phòng CTSV', 'Phòng Tuyển sinh và Công tác sinh viên', 'TS&CTSV')),
    C('phong-khtc', 'Phòng Kế hoạch – Tài chính', alt=('KHTC', 'Phòng Kế hoạch - Tài chính')),
)

#: ``faculty`` / ``domainMatch`` fixture columns become org-unit broad / domain close mappings.
_PROGRAM = (
    C('p-7480201', 'Công nghệ thông tin', alt=('ngành CNTT',), mappings=(('moet-program', '7480201', 'exact'), ('org-unit', 'khoa-cntt', 'broad'), ('domain', 'it', 'close'))),
    C('p-7480203', 'Kỹ thuật dữ liệu', mappings=(('moet-program', '7480203', 'exact'), ('org-unit', 'khoa-cntt', 'broad'), ('domain', 'it-khdl', 'close'))),
    C('p-7510301', 'Công nghệ kỹ thuật điện, điện tử', mappings=(('moet-program', '7510301', 'exact'), ('org-unit', 'khoa-dien-dien-tu', 'broad'), ('domain', 'ee', 'close'))),
    C('p-7510208', 'Năng lượng tái tạo', mappings=(('moet-program', '7510208', 'exact'), ('org-unit', 'khoa-giao-thong-nang-luong', 'broad'), ('domain', 've-nang-luong-tai-tao', 'close'))),
)


def _rule(code: str, when: str, then: str, effect: str, weight: float | None = None) -> R:
    """A rules.csv row: ``code,when,then,effect,weight``."""
    when_scheme, when_notation = when.split(":")
    then_scheme, then_notation = then.split(":")
    return R(
        code,
        then=(then_scheme, then_notation),
        when_concept=(when_scheme, when_notation),
        effect=effect,
        weight=weight,
    )


_RULES = (
    # templates/vn-university/rules.csv
    _rule("do-an-function", "document-type:do-an", "function:dt-do-an", "implies"),
    _rule("do-an-audience", "document-type:do-an", "audience:sinh-vien", "implies"),
    _rule("luan-van-function-do-an", "document-type:luan-van", "function:dt-do-an", "implies"),
    _rule("luan-van-function-sau-dai-hoc", "document-type:luan-van", "function:dt-sau-dai-hoc", "implies"),
    _rule("luan-van-audience", "document-type:luan-van", "audience:hoc-vien-sau-dai-hoc", "implies"),
    _rule("bai-bao-function", "document-type:bai-bao", "function:kh-cong-bo", "implies"),
    _rule("bai-bao-audience", "document-type:bai-bao", "audience:giang-vien", "implies"),
    _rule("giao-trinh-function", "document-type:giao-trinh", "function:dt-hoc-lieu", "implies"),
    _rule("giao-trinh-audience", "document-type:giao-trinh", "audience:sinh-vien", "prior", 0.7),
    _rule("de-cuong-hoc-phan-function", "document-type:de-cuong-hoc-phan", "function:dt-hoc-lieu", "implies"),
    _rule("de-cuong-hoc-phan-audience", "document-type:de-cuong-hoc-phan", "audience:sinh-vien", "prior", 0.7),
    _rule("chuong-trinh-dao-tao-function", "document-type:chuong-trinh-dao-tao", "function:dt-ctdt", "implies"),
    _rule("de-thi-function", "document-type:de-thi", "function:dt-thi", "implies"),
    _rule("de-thi-audience", "document-type:de-thi", "audience:sinh-vien", "prior", 0.7),
    # hcmute/rules.csv
    _rule("phong-dao-tao-dt", "org-unit:phong-dao-tao", "function:dt", "prior", 0.6),
    _rule("vien-sau-dai-hoc-dt-sau-dai-hoc", "org-unit:vien-sau-dai-hoc", "function:dt-sau-dai-hoc", "prior", 0.6),
    _rule("vien-sau-dai-hoc-ts-sau-dai-hoc", "org-unit:vien-sau-dai-hoc", "function:ts-sau-dai-hoc", "prior", 0.4),
    _rule("phong-ctsv-sv", "org-unit:phong-ctsv", "function:sv", "prior", 0.6),
    _rule("phong-khtc-tc", "org-unit:phong-khtc", "function:tc", "prior", 0.6),
    _rule("p-7480201-it", "program:p-7480201", "domain:it", "prior", 0.6),
    _rule("p-7480203-it-khdl", "program:p-7480203", "domain:it-khdl", "prior", 0.6),
    _rule("p-7510301-ee", "program:p-7510301", "domain:ee", "prior", 0.6),
    _rule("p-7510208-ve-nang-luong-tai-tao", "program:p-7510208", "domain:ve-nang-luong-tai-tao", "prior", 0.6),
)

_SCHEMES = {
    "domain": S(
        _DOMAIN,
        name="Lĩnh vực chuyên môn",
        min_labels=0,
        max_labels=3,
        has_primary=True,
        assign_top_concepts=False,
        max_depth=3,
        llm_policy="always",
        auto_threshold=0.9,
        review_threshold=0.5,
    ),
    "function": S(
        _FUNCTION,
        name="Nghiệp vụ",
        min_labels=1,
        max_labels=2,
        assign_top_concepts=False,
        section_assignments=True,
        llm_policy="always",
        auto_threshold=0.9,
        review_threshold=0.5,
    ),
    "document-type": S(
        _DOCUMENT_TYPE,
        name="Loại văn bản",
        min_labels=1,
        max_labels=1,
        assign_top_concepts=True,
        llm_policy="fallback",
        auto_threshold=0.9,
        review_threshold=0.5,
    ),
    "audience": S(
        _AUDIENCE,
        name="Đối tượng",
        min_labels=0,
        max_labels=None,
        assign_top_concepts=True,
        llm_policy="fallback",
        auto_threshold=0.9,
        review_threshold=0.5,
    ),
    "org-unit": S(_ORG_UNIT, name="Đơn vị", purpose="authority"),
    "program": S(_PROGRAM, name="Ngành đào tạo", purpose="authority"),
}

# -- The seven documents ----------------------------------------------------------

_HEADER = "TRƯỜNG ĐẠI HỌC CÔNG NGHỆ KỸ THUẬT TP.HCM"
_MOTTO = "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM\nĐộc lập – Tự do – Hạnh phúc"


@dataclass(frozen=True, eq=False)
class _Doc:
    """A document: its title (item name), blocks (``#`` = level-1 heading) and the
    model's scripted answer: scheme code -> notations (primary first; a ``!`` entry
    is a raw label), or ``None`` for "nothing fits" (certainty high)."""

    title: str
    blocks: tuple[str, ...]
    answer: dict[str, tuple[str, ...] | None] = field(default_factory=dict)


_CTDT = _Doc(
    "Quyết định ban hành chương trình đào tạo ngành Kỹ thuật dữ liệu khóa 2025",
    (
        _HEADER,
        _MOTTO,
        "Số: 123/QĐ-ĐHCNKT-ĐT",
        "TP. Hồ Chí Minh, ngày 05 tháng 8 năm 2025",
        "# QUYẾT ĐỊNH",
        "Về việc ban hành chương trình đào tạo trình độ đại học ngành Kỹ thuật dữ liệu khóa 2025 (K2025)",
        "HIỆU TRƯỞNG TRƯỜNG ĐẠI HỌC CÔNG NGHỆ KỸ THUẬT TP.HCM. Căn cứ Luật Giáo dục đại học; căn cứ "
        "Quy chế đào tạo trình độ đại học của Trường; theo đề nghị của Trưởng phòng Đào tạo,",
        "Điều 1. Ban hành kèm theo Quyết định này chương trình đào tạo trình độ đại học ngành Kỹ thuật "
        "dữ liệu (mã ngành 7480203), gồm 150 tín chỉ với các khối kiến thức khoa học dữ liệu, kho dữ "
        "liệu, khai phá dữ liệu và dữ liệu lớn. Chương trình áp dụng cho sinh viên khóa 2025 ngành Kỹ "
        "thuật dữ liệu.",
        "Điều 2. Quyết định này có hiệu lực thi hành kể từ ngày 01 tháng 9 năm 2025.",
        "Điều 3. Trưởng phòng Đào tạo, Trưởng khoa Công nghệ Thông tin và sinh viên khóa 2025 ngành Kỹ "
        "thuật dữ liệu chịu trách nhiệm thi hành Quyết định này.",
    ),
    {
        # D999 is not a label of the run: it is dropped.
        "domain": ("it-khdl", "!D999"),
        "function": ("dt-ctdt",),
        "audience": ("sinh-vien",),
    },
)

_TOT_NGHIEP = _Doc(
    "Thông báo xét tốt nghiệp đợt 3 năm 2026",
    (
        _HEADER,
        "KHOA ĐIỆN – ĐIỆN TỬ",
        _MOTTO,
        "Số: 87/TB-KĐĐT",
        "TP. Hồ Chí Minh, ngày 12 tháng 5 năm 2026",
        "# THÔNG BÁO",
        "Về việc xét tốt nghiệp đợt 3 năm 2026",
        "Khoa Điện – Điện tử thông báo đến sinh viên các ngành Công nghệ kỹ thuật điện, điện tử kế "
        "hoạch xét tốt nghiệp đợt 3 năm 2026. Sinh viên đã hoàn thành chương trình, đạt chuẩn đầu ra "
        "ngoại ngữ và tin học nộp đơn đề nghị xét tốt nghiệp tại văn phòng khoa.",
        "Hạn nộp hồ sơ: trước 17 giờ ngày 30 tháng 5 năm 2026. Kết quả xét tốt nghiệp và lịch nhận "
        "bằng tốt nghiệp sẽ được thông báo trên trang thông tin của khoa.",
    ),
    {"domain": None, "function": ("dt-tot-nghiep",), "audience": ("sinh-vien",)},
)

_TUYEN_SINH = _Doc(
    "Thông báo tuyển sinh trình độ thạc sĩ đợt 2 năm 2026",
    (
        _HEADER,
        "VIỆN SAU ĐẠI HỌC",
        _MOTTO,
        "Số: 52/TB-ĐHCNKT-SĐH",
        "TP. Hồ Chí Minh, ngày 20 tháng 6 năm 2026",
        "# THÔNG BÁO",
        "Tuyển sinh trình độ thạc sĩ đợt 2 năm 2026",
        "Trường Đại học Công nghệ Kỹ thuật TP.HCM thông báo tuyển sinh thạc sĩ đợt 2 năm 2026 với 24 "
        "chuyên ngành. Phương thức tuyển sinh: xét tuyển và thi tuyển. Người dự tuyển phải tốt nghiệp "
        "đại học ngành phù hợp và có năng lực ngoại ngữ theo quy định.",
        "Hồ sơ dự tuyển sau đại học nộp trực tiếp tại Viện Sau đại học hoặc đăng ký trực tuyến trước "
        "ngày 15 tháng 8 năm 2026.",
    ),
    {"domain": None, "function": ("ts-sau-dai-hoc",), "audience": ("hoc-vien-sau-dai-hoc",)},
)

_GIAO_TRINH = _Doc(
    "Giáo trình Học máy",
    (
        _HEADER,
        "KHOA CÔNG NGHỆ THÔNG TIN",
        "# GIÁO TRÌNH HỌC MÁY",
        "Giáo trình dùng cho sinh viên đại học ngành Công nghệ thông tin và Kỹ thuật dữ liệu.",
        "Chương 1 giới thiệu học máy có giám sát: hồi quy tuyến tính, hồi quy logistic và các thuật toán "
        "phân lớp. Chương 2 trình bày học không giám sát, phân cụm k-means và giảm chiều dữ liệu.",
        "# Chương 3. Mạng nơ-ron và học sâu",
        "Mạng nơ-ron nhiều lớp, lan truyền ngược, hàm kích hoạt và kỹ thuật chống quá khớp; bài tập "
        "cuối chương dùng thư viện scikit-learn và PyTorch.",
    ),
    {"domain": ("it-ai",), "audience": ("sinh-vien",)},
)

_BAI_BAO = _Doc(
    "Tối ưu hóa công suất hệ thống điện mặt trời áp mái bằng thuật toán bầy đàn",
    (
        "# Abstract",
        "This paper proposes a particle swarm optimization method that maximizes the output of rooftop "
        "solar photovoltaic systems under partial shading. DOI: https://doi.org/10.1109/ICSSE.2026.0123",
        "Tóm tắt: Bài báo đề xuất phương pháp tối ưu bầy đàn để bám điểm công suất cực đại cho hệ thống "
        "điện mặt trời áp mái khi bị che bóng một phần. Kết quả mô phỏng cho thấy sản lượng pin mặt "
        "trời tăng 7,4% so với thuật toán P&O.",
        "Từ khóa: điện mặt trời, năng lượng tái tạo, tối ưu bầy đàn, MPPT.",
        "# 1. Giới thiệu",
        "Năng lượng tái tạo chiếm tỷ trọng ngày càng lớn trong cơ cấu nguồn điện; điện mặt trời áp mái "
        "phát triển nhanh tại các đô thị phía Nam.",
    ),
    {"domain": ("ve-nang-luong-tai-tao",)},
)

_MIEN_GIAM = _Doc(
    "Quy định miễn, giảm học phí đối với sinh viên đại học chính quy",
    (
        _HEADER,
        _MOTTO,
        "Số: 15/QyĐ-ĐHCNKT-KHTC",
        "TP. Hồ Chí Minh, ngày 10 tháng 9 năm 2025",
        "# QUY ĐỊNH",
        "Về việc miễn giảm học phí đối với sinh viên đại học chính quy",
        "Điều 1. Đối tượng được miễn học phí: sinh viên là con của người có công với cách mạng, sinh "
        "viên khuyết tật, sinh viên mồ côi cả cha lẫn mẹ.",
        "Điều 2. Đối tượng được giảm học phí 70% hoặc 50%: sinh viên người dân tộc thiểu số thuộc hộ "
        "nghèo, cận nghèo. Hồ sơ miễn giảm học phí nộp tại Phòng Kế hoạch – Tài chính trong bốn tuần "
        "đầu mỗi học kỳ.",
    ),
    {"domain": None, "function": ("mien-giam-hoc-phi",), "audience": ("sinh-vien",)},
)

_KHOA_LUAN = _Doc(
    "Khóa luận tốt nghiệp: Nhận diện khuôn mặt bằng mạng nơ-ron tích chập CNN",
    (
        _HEADER,
        "KHOA CÔNG NGHỆ THÔNG TIN",
        "# KHÓA LUẬN TỐT NGHIỆP",
        "Đề tài: Nhận diện khuôn mặt bằng mạng nơ-ron tích chập (CNN). Sinh viên thực hiện: Nguyễn Văn "
        "An, MSSV 21110001. Giảng viên hướng dẫn: TS. Trần Minh Khoa.",
        "Khóa luận xây dựng hệ thống nhận diện khuôn mặt cho điểm danh sinh viên: phát hiện khuôn mặt "
        "bằng MTCNN, trích đặc trưng bằng CNN và so khớp bằng khoảng cách cosine; độ chính xác 97,2% "
        "trên tập dữ liệu 1.200 ảnh.",
    ),
    {"domain": ("it-thi-giac-may-tinh", "it-ai")},
)

_DOCUMENTS = (_CTDT, _TOT_NGHIEP, _TUYEN_SINH, _GIAO_TRINH, _BAI_BAO, _MIEN_GIAM, _KHOA_LUAN)

#: Processed by a run restricted to document type, function and audience: every
#: scheme is settled by rules, the model is not asked.
_SETTLED = _Doc(
    "Khóa luận tốt nghiệp: Xây dựng hệ thống gợi ý sách cho thư viện",
    (
        _HEADER,
        "KHOA CÔNG NGHỆ THÔNG TIN",
        "# KHÓA LUẬN TỐT NGHIỆP",
        "Đề tài: Xây dựng hệ thống gợi ý sách cho thư viện bằng lọc cộng tác.",
    ),
)


def _structure(doc: _Doc) -> DoclingDocument:
    parsed = DoclingDocument(name="document")
    for block in doc.blocks:
        if block.startswith("# "):
            parsed.add_heading(block[2:], level=1)
        else:
            parsed.add_text(label=DocItemLabel.PARAGRAPH, text=block)
    return parsed


class _Structures:
    """A StructureStore holding each document's Structured Document (no object storage)."""

    def __init__(self) -> None:
        self.documents: dict[UUID, DoclingDocument] = {}

    async def ensure(
        self, document: Item, *, revision: ItemRevision | None = None, **_: Any
    ) -> ParsedStructure:
        assert revision is not None
        parsed = self.documents[document.id]
        ref = StructureRef(document.workspace_code, revision.content_id, "0123456789abcdef")
        manifest = StructureManifest(
            fingerprint=ref.fingerprint,
            docling_schema=parsed.version,
            size_bytes=0,
            nodes=len(parsed.texts),
            pictures=0,
        )
        return ParsedStructure(ref, manifest, parsed)


# -- The scripted model ---------------------------------------------------------------

_LABEL_LINE = re.compile(r"^\s*(?:[-*]\s*)?(?P<label>[A-Z][A-Z0-9]*?\d+)\b\s*(?:\||—|-|:)?\s*(?P<rest>.*)$")


@dataclass
class _Call:
    prefix: str
    document: str
    blocks: int


class _ScriptedModel:
    """The contextualization model: chunk contexts get an empty answer; a
    classification call is answered from the script of the document whose
    title is in the document part, naming labels found in the prompt."""

    model = "configured-contextualization-model"

    def __init__(self, documents: tuple[_Doc, ...]) -> None:
        self.documents = documents
        self.calls: list[_Call] = []

    async def responses(self, *, input: Any, **params: Any) -> Any:
        if isinstance(input, str) or str(params.get("prompt_cache_key", "")).startswith(
            "chunk-context:"
        ):
            return SimpleNamespace(output_text='{"contexts": []}')
        texts = [block["text"] for block in input[0]["content"]]
        call = _Call(prefix=texts[0], document=texts[1], blocks=len(texts))
        self.calls.append(call)
        doc = self.of(call)
        # The prompt renderer escapes markup (``&`` reads ``&amp;``).
        prompt = html.unescape("\n".join(texts))
        schemes: dict[str, Any] = {}
        for scheme, notations in doc.answer.items():
            if notations is None:
                schemes[scheme] = {"none": True, "certainty": "high"}
                continue
            labels = [n[1:] if n.startswith("!") else _label(prompt, _NAMES[scheme][n]) for n in notations]
            schemes[scheme] = {
                "primary": labels[0],
                "secondary": labels[1:],
                "certainty": "high",
                "evidence": doc.title,
            }
        answer = {"schemes": schemes, "summary": f"Tóm tắt: {doc.title}.", "title": doc.title}
        return SimpleNamespace(output_text=json.dumps(answer, ensure_ascii=False))

    def of(self, call: _Call) -> _Doc:
        matching = [doc for doc in self.documents if doc.title in call.document]
        assert len(matching) == 1, call.document[:400]
        return matching[0]


_NAMES = {
    code: {concept.notation: concept.pref for concept in spec.concepts} for code, spec in _SCHEMES.items()
}


def _label(prompt: str, name: str) -> str:
    """The label of the concept listed in ``prompt`` as ``name`` (its path's last step)."""
    for line in prompt.splitlines():
        match = _LABEL_LINE.match(line)
        if match is None:
            continue
        head = re.split(r"\s+\|\s+|\s+—\s+", match["rest"], maxsplit=1)[0]
        if head.split("›")[-1].strip() == name:
            return match["label"]
    raise AssertionError(f"no label for {name!r} in the prompt")


def _contextualized(runtime: AppRuntime, fakes: Fakes, model: _ScriptedModel) -> None:
    runtime._index = ItemIndex(
        backend=fakes.index_backend,  # type: ignore[arg-type]
        embedder=fakes.embedder,
        semantic_contextualizer=SemanticContextualizer(
            model, model_name=model.model  # type: ignore[arg-type]
        ),
    )


# -- Reading what CLASSIFYING wrote --------------------------------------------------------


@dataclass(frozen=True)
class _Row:
    scheme: str
    notation: str
    source: str
    state: str
    confidence: float
    primary: bool
    evidence: dict[str, Any]


async def _rows(sessions: Sessions, item_id: UUID) -> dict[tuple[str, str], _Row]:
    async with transaction_scope(sessions) as session:
        result = await session.execute(
            select(ItemConcept, Concept.notation, ConceptScheme.code)
            .join(Concept, Concept.id == ItemConcept.concept_id)
            .join(ConceptScheme, ConceptScheme.id == ItemConcept.scheme_id)
            .where(ItemConcept.item_id == item_id, ItemConcept.section_ref.is_(None))
        )
        return {
            (code, notation): _Row(
                code,
                notation,
                row.source,
                row.state,
                row.confidence,
                row.is_primary,
                dict(row.evidence or {}),
            )
            for row, notation, code in result.all()
        }


async def _outcomes(sessions: Sessions, item_id: UUID) -> dict[str, str]:
    async with transaction_scope(sessions) as session:
        result = await session.execute(
            select(ConceptScheme.code, ItemClassification.outcome)
            .join(ConceptScheme, ConceptScheme.id == ItemClassification.scheme_id)
            .where(ItemClassification.item_id == item_id)
        )
        return dict(result.all())


async def _profile(
    sessions: Sessions, item_id: UUID
) -> tuple[DocumentProfile | None, set[str]]:
    async with transaction_scope(sessions) as session:
        profile = await session.get(DocumentProfile, item_id)
        applicability = set(
            await session.scalars(
                select(Concept.notation)
                .join(DocumentApplicability, DocumentApplicability.concept_id == Concept.id)
                .where(DocumentApplicability.item_id == item_id)
            )
        )
        return profile, applicability


async def _function_tops(sessions: Sessions, item_id: UUID) -> set[str]:
    """Top concepts of the function scheme the document rolls up to (published closure)."""
    async with transaction_scope(sessions) as session:
        result = await session.execute(
            text(
                """
                SELECT DISTINCT ancestor.notation
                FROM item_concepts AS assigned
                JOIN concept_schemes AS scheme ON scheme.id = assigned.scheme_id
                JOIN concept_closure AS closure ON closure.descendant_id = assigned.concept_id
                JOIN concepts AS ancestor ON ancestor.id = closure.ancestor_id
                WHERE assigned.item_id = :item
                  AND assigned.state <> 'rejected'
                  AND scheme.code = 'function'
                  AND closure.depth > 0
                  AND NOT EXISTS (
                      SELECT 1 FROM concept_relations AS relation
                      WHERE relation.source_concept_id = ancestor.id AND relation.kind = 'broader'
                  )
                """
            ),
            {"item": item_id},
        )
        return set(result.scalars())


def _line(document_part: str, label: str) -> str:
    """The document part's line listing ``label`` (a shortlist entry)."""
    for line in document_part.splitlines():
        match = _LABEL_LINE.match(line)
        if match is not None and match["label"] == label:
            return line
    raise AssertionError(f"{label} is not listed in the document part:\n{document_part}")


# -- The acceptance test ---------------------------------------------------------------------


@dataclass
class _Run:
    plan: ClassificationPlan
    taxonomy: Taxonomy
    items: dict[str, UUID]
    model: _ScriptedModel
    calls: dict[str, list[_Call]]

    def label(self, scheme: str, notation: str) -> str:
        concept = self.taxonomy.concept(scheme, notation)
        labels = [label for label, cid in self.plan.labels.items() if cid == concept]
        assert len(labels) == 1, (scheme, notation, labels)
        return labels[0]

    def document_part(self, doc: _Doc) -> str:
        assert len(self.calls[doc.title]) == 1, doc.title
        return self.calls[doc.title][0].document


async def _process(
    runtime: AppRuntime, fakes: Fakes, world: World, sessions: Sessions
) -> tuple[_Run, ItemIngestionService, _Structures, Any]:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    library = await world.make_collection(workspace, item_name="Văn bản HCM-UTE")
    taxonomy = await seed_taxonomy(sessions, workspace, admin, _SCHEMES, rules=_RULES)
    model = _ScriptedModel((*_DOCUMENTS, _SETTLED))
    _contextualized(runtime, fakes, model)
    structures = _Structures()
    ingestion = ItemIngestionService(
        sessions, index=runtime.item_index(), structures=structures  # type: ignore[arg-type]
    )
    plan = await ingestion.classification_plan(
        workspace.id, RunClassification(note="Văn bản và học liệu của Trường ĐH Công nghệ Kỹ thuật TP.HCM")
    )
    assert plan is not None
    items: dict[str, UUID] = {}
    for doc in _DOCUMENTS:
        document = await world.make_document(library, item_name=doc.title)
        structures.documents[document.id] = _structure(doc)
        items[doc.title] = document.id
        await ingestion.process_document(document.id, tenant_id=workspace.id, plan=plan)
    calls: dict[str, list[_Call]] = {doc.title: [] for doc in _DOCUMENTS}
    for call in model.calls:
        calls[model.of(call).title].append(call)
    return _Run(plan, taxonomy, items, model, calls), ingestion, structures, (workspace, library)


async def test_seven_documents_are_classified_by_rules_then_one_model_call_each(
    runtime: AppRuntime, fakes: Fakes, world: World, sessions: Sessions
) -> None:
    run, ingestion, structures, (workspace, library) = await _process(runtime, fakes, world, sessions)

    # One model call per document (the domain is always asked), no retry: the
    # unknown D999 is dropped while valid labels remain.
    assert {title: len(calls) for title, calls in run.calls.items()} == {
        doc.title: 1 for doc in _DOCUMENTS
    }
    assert all(call.blocks == 2 for call in run.model.calls)
    # The shared prefix (instructions, note, every scheme) is identical for the
    # whole run; the documents differ only in their own part.
    prefixes = {call.prefix for call in run.model.calls}
    assert len(prefixes) == 1
    (prefix,) = prefixes
    assert "Văn bản và học liệu của Trường ĐH Công nghệ Kỹ thuật TP.HCM" in prefix
    assert not any(doc.title in prefix for doc in _DOCUMENTS)
    assert run.label("function", "mien-giam-hoc-phi") in prefix

    rows = {doc.title: await _rows(sessions, run.items[doc.title]) for doc in _DOCUMENTS}
    outcomes = {doc.title: await _outcomes(sessions, run.items[doc.title]) for doc in _DOCUMENTS}

    def settled(doc: _Doc, scheme: str) -> set[str]:
        return {n for (s, n), row in rows[doc.title].items() if s == scheme and row.source == "rule"}

    def chosen(doc: _Doc, scheme: str) -> set[str]:
        return {n for (s, n), row in rows[doc.title].items() if s == scheme and row.source == "llm"}

    # T: exactly one pattern matched the title, number or first heading.
    expected_types = {
        _CTDT: "quyet-dinh",
        _TOT_NGHIEP: "thong-bao",
        _TUYEN_SINH: "thong-bao",
        _GIAO_TRINH: "giao-trinh",
        _BAI_BAO: "bai-bao",
        _MIEN_GIAM: "quy-dinh",
        _KHOA_LUAN: "do-an",
    }
    for doc, notation in expected_types.items():
        row = rows[doc.title][("document-type", notation)]
        assert (row.source, row.state, row.confidence) == ("rule", "accepted", 1.0), doc.title
        assert row.evidence.get("pattern"), doc.title
        assert {n for s, n in rows[doc.title] if s == "document-type"} == {notation}, doc.title
        assert outcomes[doc.title]["document-type"] == "assigned", doc.title

    # implies T -> F / A: settled by rule, confidence 1.0, accepted; never asked.
    implied = {
        _GIAO_TRINH: {("function", "dt-hoc-lieu"): "giao-trinh-function"},
        _BAI_BAO: {
            ("function", "kh-cong-bo"): "bai-bao-function",
            ("audience", "giang-vien"): "bai-bao-audience",
        },
        _KHOA_LUAN: {
            ("function", "dt-do-an"): "do-an-function",
            ("audience", "sinh-vien"): "do-an-audience",
        },
    }
    for doc, expected in implied.items():
        for key, code in expected.items():
            row = rows[doc.title][key]
            assert (row.source, row.state, row.confidence) == ("rule", "accepted", 1.0), (doc.title, key)
            assert row.evidence.get("rule") == code, (doc.title, key)
    assert settled(_GIAO_TRINH, "function") == {"dt-hoc-lieu"}
    assert settled(_BAI_BAO, "function") == {"kh-cong-bo"}
    assert settled(_BAI_BAO, "audience") == {"giang-vien"}
    assert settled(_KHOA_LUAN, "audience") == {"sinh-vien"}
    for doc in (_GIAO_TRINH, _BAI_BAO, _KHOA_LUAN):
        assert chosen(doc, "function") == set(), doc.title
    for doc in (_BAI_BAO, _KHOA_LUAN):
        assert chosen(doc, "audience") == set(), doc.title
    for doc in (_GIAO_TRINH, _BAI_BAO, _KHOA_LUAN):
        assert outcomes[doc.title]["function"] == "assigned", doc.title

    # Shortlists in each document part: lexical hits, the program prior, unit priors.
    khdl = _line(run.document_part(_CTDT), run.label("domain", "it-khdl"))
    assert "lexical" in khdl and "prior" in khdl
    _line(run.document_part(_TOT_NGHIEP), run.label("function", "dt-tot-nghiep"))
    _line(run.document_part(_TUYEN_SINH), run.label("function", "ts-sau-dai-hoc"))
    _line(run.document_part(_GIAO_TRINH), run.label("domain", "it-ai"))
    # Audience falls back to the model with any label; the giáo trình prior on
    # sinh viên ranks it first among the prepared candidates.
    assert "any label of scheme audience" in run.document_part(_GIAO_TRINH)
    text_of_giao_trinh = "\n".join(block.removeprefix("# ") for block in _GIAO_TRINH.blocks)
    prepared = await prepare(
        run.plan,
        DocumentInput(title=_GIAO_TRINH.title, context=text_of_giao_trinh, head=text_of_giao_trinh),
    )
    audience = prepared.candidates["audience"]
    assert audience[0].concept_id == run.taxonomy.concept("audience", "sinh-vien")
    assert dict(audience[0].scores).get("prior") == pytest.approx(0.7)
    assert {row.concept_id for row in prepared.settled["function"]} == {
        run.taxonomy.concept("function", "dt-hoc-lieu")
    }
    _line(run.document_part(_BAI_BAO), run.label("domain", "ve-nang-luong-tai-tao"))
    _line(run.document_part(_MIEN_GIAM), run.label("function", "mien-giam-hoc-phi"))
    _line(run.document_part(_KHOA_LUAN), run.label("domain", "it-thi-giac-may-tinh"))

    # The model's choices, routed by the calibrated confidence and the scheme's thresholds.
    expected_choices = {
        _CTDT: {"domain": {"it-khdl"}, "function": {"dt-ctdt"}, "audience": {"sinh-vien"}},
        _TOT_NGHIEP: {"domain": set(), "function": {"dt-tot-nghiep"}, "audience": {"sinh-vien"}},
        _TUYEN_SINH: {
            "domain": set(),
            "function": {"ts-sau-dai-hoc"},
            "audience": {"hoc-vien-sau-dai-hoc"},
        },
        _GIAO_TRINH: {"domain": {"it-ai"}, "audience": {"sinh-vien"}},
        _BAI_BAO: {"domain": {"ve-nang-luong-tai-tao"}},
        _MIEN_GIAM: {"domain": set(), "function": {"mien-giam-hoc-phi"}, "audience": {"sinh-vien"}},
        _KHOA_LUAN: {"domain": {"it-thi-giac-may-tinh", "it-ai"}},
    }
    for doc, expected in expected_choices.items():
        for scheme, notations in expected.items():
            assert chosen(doc, scheme) == notations, (doc.title, scheme)
            for notation in notations:
                row = rows[doc.title][(scheme, notation)]
                assert row.confidence >= 0.5, (doc.title, notation)
                # item_concepts.confidence is a ``real``: 0.9 reads back as 0.89999998.
                assert row.state == route(round(row.confidence, 4), run.plan.scheme(scheme)), (
                    doc.title,
                    notation,
                )
                assert row.evidence.get("quote") == doc.title, (doc.title, notation)
            if notations:
                assert outcomes[doc.title][scheme] == "assigned", (doc.title, scheme)
    assert rows[_CTDT.title][("domain", "it-khdl")].primary is True
    assert rows[_KHOA_LUAN.title][("domain", "it-thi-giac-may-tinh")].primary is True
    assert rows[_KHOA_LUAN.title][("domain", "it-ai")].primary is False

    # "Nothing fits" with high certainty on a scheme that may be empty.
    for doc in (_TOT_NGHIEP, _TUYEN_SINH, _MIEN_GIAM):
        assert outcomes[doc.title]["domain"] == "empty", doc.title
        assert not any(s == "domain" for s, _ in rows[doc.title]), doc.title

    # Miễn, giảm học phí has two broader concepts: the document rolls up under both tops.
    assert await _function_tops(sessions, run.items[_MIEN_GIAM.title]) == {"tc", "sv"}

    # Metadata found by rules (NĐ 30/2020 layout), written to document_profiles.
    profile, applicability = await _profile(sessions, run.items[_CTDT.title])
    assert profile is not None
    assert profile.document_number == "123/QĐ-ĐHCNKT-ĐT"
    assert profile.issued_on == date(2025, 8, 5)
    assert profile.effective_on == date(2025, 9, 1)
    assert profile.issuer_concept_id == run.taxonomy.concept("org-unit", "phong-dao-tao")
    assert applicability == {"p-7480203"}
    assert list(profile.applicability_cohorts or []) == [2025]
    assert profile.field_sources.get("number") == "extracted"
    assert profile.field_sources.get("issuer") == "extracted"

    profile, _ = await _profile(sessions, run.items[_TOT_NGHIEP.title])
    assert profile is not None
    assert profile.document_number == "87/TB-KĐĐT"
    assert profile.issued_on == date(2026, 5, 12)
    assert profile.issuer_concept_id == run.taxonomy.concept("org-unit", "khoa-dien-dien-tu")

    profile, _ = await _profile(sessions, run.items[_TUYEN_SINH.title])
    assert profile is not None
    assert profile.issuer_concept_id == run.taxonomy.concept("org-unit", "vien-sau-dai-hoc")

    profile, _ = await _profile(sessions, run.items[_MIEN_GIAM.title])
    assert profile is not None
    assert profile.document_number == "15/QyĐ-ĐHCNKT-KHTC"
    assert profile.issued_on == date(2025, 9, 10)
    assert profile.issuer_concept_id == run.taxonomy.concept("org-unit", "phong-khtc")

    # Every document is indexed.
    async with transaction_scope(sessions) as session:
        statuses = {
            (await session.get(Item, item_id)).index_status  # type: ignore[union-attr]
            for item_id in run.items.values()
        }
    assert statuses == {"ready"}

    # A run restricted to the rule-settled schemes asks the model nothing.
    restricted = await ingestion.classification_plan(
        workspace.id, RunClassification(schemes=("document-type", "function", "audience"))
    )
    assert restricted is not None
    document = await world.make_document(library, item_name=_SETTLED.title)
    structures.documents[document.id] = _structure(_SETTLED)
    before = len(run.model.calls)

    await ingestion.process_document(document.id, tenant_id=workspace.id, plan=restricted)

    assert len(run.model.calls) == before
    settled_rows = await _rows(sessions, document.id)
    assert {key: (row.source, row.state) for key, row in settled_rows.items()} == {
        ("document-type", "do-an"): ("rule", "accepted"),
        ("function", "dt-do-an"): ("rule", "accepted"),
        ("audience", "sinh-vien"): ("rule", "accepted"),
    }
    assert await _outcomes(sessions, document.id) == {
        "document-type": "assigned",
        "function": "assigned",
        "audience": "assigned",
    }
