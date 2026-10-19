"""Export saved historical UAT results with Python's standard library."""

import json
import xml.etree.ElementTree as ET
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'UAT-Test-Results.xlsx'


def column_name(index):
    """Convert a one-based column number to an Excel letter, such as 1 -> A."""
    result = ''
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result

def build_sheet(headers, rows, widths, status_index):
    """Build the XML for one worksheet, including its header and status colors."""
    end = f'{column_name(len(headers))}{len(rows) + 1}'
    parts = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
        f'<dimension ref="A1:{end}"/>',
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
        '<sheetFormatPr defaultRowHeight="18"/><cols>',
    ]
    for index, width in enumerate(widths, 1):
        parts.append(f'<col min="{index}" max="{index}" width="{width}" customWidth="1"/>')
    parts.append('</cols><sheetData>')
    for row_num, values in enumerate([headers] + rows, 1):
        height = 140
        if row_num == 1:
            height = 32
        elif row_num == 12:
            height = 180
        parts.append(f'<row r="{row_num}" ht="{height}" customHeight="1">')
        for index, value in enumerate(values, 1):
            # Style 1 is the header; 2 is a normal row; 3 and 4 are status colors.
            style = 2
            if row_num == 1:
                style = 1
            if row_num > 1 and index - 1 == status_index:
                if value == 'Passed':
                    style = 3
                elif value == 'Blocked':
                    style = 4
            cell_address = f'{column_name(index)}{row_num}'
            cell_text = escape(str(value))
            parts.append(
                f'<c r="{cell_address}" s="{style}" t="inlineStr">'
                f'<is><t xml:space="preserve">{cell_text}</t></is></c>'
            )
        parts.append('</row>')
    parts.extend([
        '</sheetData>',
        f'<autoFilter ref="A1:{end}"/>',
        '<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>',
        '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>',
        '</worksheet>',
    ])
    return ''.join(parts)


# These XML styles are the fixed spreadsheet layout. Result rows live in the JSON file.
STYLES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF17365D"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2F0D9"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFE699"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border/><border><left style="thin"><color rgb="FFD9E2F3"/></left><right style="thin"><color rgb="FFD9E2F3"/></right><top style="thin"><color rgb="FFD9E2F3"/></top><bottom style="thin"><color rgb="FFD9E2F3"/></bottom></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'''

def create_workbook(output, data):
    """Write the saved result rows and the required XLSX package files."""
    headers = data['HEADERS']
    rows = data['ROWS']
    provided_headers = data['PROVIDED_HEADERS']
    provided_rows = data['PROVIDED_ROWS']
    with ZipFile(output, 'w', ZIP_DEFLATED) as book:
        book.writestr('[Content_Types].xml', '''<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>''')
        book.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        book.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="UAT Results" sheetId="1" r:id="rId1"/><sheet name="Provided Invalid Login" sheetId="2" r:id="rId2"/></sheets></workbook>')
        book.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
        book.writestr('xl/styles.xml', STYLES)
        book.writestr('xl/worksheets/sheet1.xml', build_sheet(headers, rows, [16, 32, 48, 50, 72, 14, 28, 70, 48], 5))
        book.writestr('xl/worksheets/sheet2.xml', build_sheet(provided_headers, provided_rows, [28, 48, 60, 68, 20, 20, 55, 70], 4))

def validate_workbook(output, data):
    """Check the ZIP archive, XML syntax, and expected number of rows."""
    with ZipFile(output) as book:
        assert book.testzip() is None
        for name in book.namelist():
            ET.fromstring(book.read(name))
        namespace = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        results = ET.fromstring(book.read('xl/worksheets/sheet1.xml'))
        provided = ET.fromstring(book.read('xl/worksheets/sheet2.xml'))
        assert len(results.findall('s:sheetData/s:row', namespace)) == len(data['ROWS']) + 1
        assert len(provided.findall('s:sheetData/s:row', namespace)) == len(data['PROVIDED_ROWS']) + 1


def main():
    data_file = Path(__file__).with_name('uat-results-data.json')
    data = json.loads(data_file.read_text(encoding='utf-8'))
    create_workbook(OUTPUT, data)
    validate_workbook(OUTPUT, data)
    print(f'Created and validated: {OUTPUT}')
    print(f"{len(data['ROWS'])} UAT cases plus the user-provided row in a separate sheet.")


if __name__ == '__main__':
    main()
