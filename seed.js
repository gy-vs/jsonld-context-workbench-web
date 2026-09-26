// 首启种子：演示用本地 context 资源。全部为本地引用，无公网依赖。
//   ex-base     —— @vocab + @base + 受保护词项
//   ex-profile  —— 嵌套引用 ex-base 并做词项覆盖、容器、关键字别名、属性作用域
//   ex-person   —— 演示嵌套循环资源链中的一个环节（不构成循环，供测试手动构造循环）
export const SEED_RESOURCES = [
  {
    id: 'ex-base',
    name: 'Schema 基础词表（@vocab/@base/protected）',
    content: {
      '@context': {
        '@version': 1.1,
        '@base': 'https://example.com/',
        '@vocab': 'https://schema.org/',
        '@protected': true,
        name: 'http://www.w3.org/2000/01/rdf-schema#label',
        schema: 'https://schema.org/',
        id: '@id',
        type: '@type',
      },
    },
  },
  {
    id: 'ex-profile',
    name: '人物档案 Profile（嵌套/覆盖/容器/作用域）',
    content: {
      '@context': [
        'ex-base',
        {
          // 词项覆盖：name 不再是受保护定义（先 null 移除再重定义）
          name: null,
          name_zh: { '@id': 'https://schema.org/name', '@language': 'zh' },
          name_en: { '@id': 'https://schema.org/name', '@language': 'en' },
          homepage: { '@type': '@id' },
          knows: {
            '@id': 'https://example.org/knows',
            '@container': '@index',
          },
          nicknames: { '@id': 'https://example.org/nick', '@container': '@list' },
          labels: {
            '@id': 'https://example.org/label',
            '@container': '@language',
          },
          postal: {
            '@id': 'https://example.org/postal',
            '@context': {
              '@vocab': 'https://schema.org/address/',
            },
          },
          schema_name: 'schema:name',
        },
      ],
    },
  },
  {
    id: 'ex-empty',
    name: '空重置演示（null reset）',
    content: {
      '@context': [
        'ex-base',
        null,
        {
          '@vocab': 'https://alt.example.org/vocab#',
          label: 'https://alt.example.org/vocab#label',
        },
      ],
    },
  },
];

// 该文档可直接加载到工作台
export const SEED_DOCUMENT = {
  '@context': [
    {
      '@context': ['ex-profile'],
    },
  ],
  id: 'people/042',
  type: 'Person',
  name_zh: '李雷',
  schema_name: 'Li Lei',
  homepage: 'https://li.example.org',
  nicknames: ['雷子', 'LL'],
  labels: {
    zh: '李雷',
    en: 'Li Lei',
  },
  knows: {
    'colleague': { id: 'people/007', name_zh: '韩梅梅' },
  },
  postal: {
    street: '中关村大街 1 号',
    city: '北京',
  },
  unknownField: '保留并标记',
};
