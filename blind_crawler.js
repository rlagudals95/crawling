const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function scrapeTeamblind(config) {
  // 설정 기본값 설정
  const searchKeyword = config.keyword || '폰 대리점';
  const maxPosts = config.maxPosts || 100; // 기본값 100개
  const saveComments = config.saveComments !== false; // 기본적으로 댓글 수집

  // 출력 디렉토리 생성
  const outputDir = './teamblind_data';
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
  }

  // 날짜를 포함한 파일명 생성
  const dateStr = new Date().toISOString().slice(0, 10);
  const outputBaseName = `teamblind_${searchKeyword}_${dateStr}`;
  const outputPath = path.join(outputDir, `${outputBaseName}.json`);
  const tempOutputPath = path.join(outputDir, `${outputBaseName}_temp.json`);
  
  // 브라우저 실행
  const browser = await puppeteer.launch({ 
    headless: false, // 브라우저 화면 표시
    defaultViewport: null, // 뷰포트 자동 조정
    timeout: 60000 // 타임아웃 60초로 설정
  });
  
  const page = await browser.newPage();
  
  // 페이지 타임아웃 설정
  await page.setDefaultNavigationTimeout(60000);
  
  // 데이터를 저장할 배열
  let posts = [];
  
  // 이전 데이터가 있으면 불러오기
  if (fs.existsSync(tempOutputPath)) {
    try {
      console.log('기존 임시 데이터 파일을 불러옵니다.');
      const tempData = JSON.parse(fs.readFileSync(tempOutputPath, 'utf8'));
      posts = tempData.posts || [];
      console.log(`임시 파일에서 ${posts.length}개의 게시물을 불러왔습니다.`);
    } catch (e) {
      console.error('임시 파일 불러오기 실패:', e);
    }
  }
  
  try {
    // 검색 결과 페이지로 이동
    const encodedKeyword = encodeURIComponent(searchKeyword);
    await page.goto(`https://www.teamblind.com/kr/search/${encodedKeyword}`, {
      waitUntil: 'networkidle2'
    });
    
    console.log(`"${searchKeyword}" 키워드로 검색한, 팀블라인드 검색 결과 페이지를 스크랩합니다.`);
    
    let previousHeight = 0;
    let isEnd = false;
    let scrollCount = 0;
    
    // 중간 저장 함수
    const saveTemporaryData = () => {
      fs.writeFileSync(tempOutputPath, JSON.stringify({
        keyword: searchKeyword,
        count: posts.length,
        lastUpdated: new Date().toISOString(),
        posts: posts
      }, null, 2));
      console.log(`임시 데이터가 ${tempOutputPath}에 저장되었습니다.`);
    };
    
    // 본문 내용 수집 함수
    const collectFullContent = async (url) => {
      await page.goto(url, { waitUntil: 'networkidle2' });
      
      return await page.evaluate(() => {
        // 본문 내용 셀렉터 - 팀블라인드 구조에 맞게 수정
        const contentEl = document.querySelector('.article-view-contents #contentArea.contents-txt');
        
        if (!contentEl) {
          // 다양한 대체 셀렉터 시도
          const alternateSelectors = [
            '.article-view-contents .contents-txt',
            '[data-v-a4bba3f8].contents-txt',
            '.article-body', 
            '.content',
            '.article-content',
            '[class*="article-view"] [class*="contents"]',
            '.post-content',
            '.post-body'
          ];
          
          for (const selector of alternateSelectors) {
            const altEl = document.querySelector(selector);
            if (altEl && altEl.textContent.trim()) {
              return altEl.textContent.trim();
            }
          }
          
          return ''; // 본문을 찾지 못한 경우
        }
        
        // 본문 텍스트
        return contentEl.textContent.trim();
      });
    };
    
    // 댓글 수집 함수
    const collectComments = async (url) => {
      if (!saveComments) return []; // 댓글 수집 비활성화된 경우
      
      try {
        // 이미 해당 URL에 있지 않으면 이동
        const currentUrl = await page.url();
        if (currentUrl !== url) {
          await page.goto(url, { waitUntil: 'networkidle2' });
        }
        
        // "더보기" 버튼 클릭 - 대댓글 펼치기
        const expandReplies = async () => {
          return await page.evaluate(() => {
            const moreBtns = Array.from(document.querySelectorAll('button.btn-reply'));
            let clicked = 0;
            
            for (const btn of moreBtns) {
              if (btn.textContent.includes('대댓글') || btn.textContent.includes('더보기')) {
                btn.click();
                clicked++;
              }
            }
            return clicked;
          });
        };
        
        // 대댓글 확장 버튼 클릭
        let expandedCount = await expandReplies();
        if (expandedCount > 0) {
          console.log(`${expandedCount}개의 대댓글 더보기 버튼을 클릭했습니다.`);
          // 대댓글 로딩 대기
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        // 모든 댓글 수집
        const comments = await page.evaluate(() => {
          // 실제 팀블라인드 댓글 구조에 맞게 셀렉터 수정
          const commentElements = Array.from(document.querySelectorAll('.wrap-comment.comment_area'));
          const results = [];
          
          for (const commentEl of commentElements) {
            try {
              // 댓글 내용이 없는 요소 무시 (댓글 작성 폼 등)
              if (!commentEl.textContent.trim()) continue;
              
              // 회사명
              const companyEl = commentEl.querySelector('a.point');
              const company = companyEl ? companyEl.textContent.trim() : '';
              
              // 닉네임 - 회사명 다음에 오는 텍스트
              const nameEl = commentEl.querySelector('p.name');
              let nickname = '';
              if (nameEl) {
                const nameText = nameEl.textContent.trim();
                // 회사명 이후의 · 뒤에 오는 부분이 닉네임
                const parts = nameText.split('·');
                if (parts.length > 1) {
                  nickname = parts[1].trim();
                }
              }
              
              // 작성자 여부 확인
              const isAuthor = !!commentEl.querySelector('em.op');
              
              // 내용
              const contentEl = commentEl.querySelector('p.cmt-txt');
              const content = contentEl ? contentEl.textContent.trim() : '';
              
              // 이미지 첨부 확인
              const hasImage = !!commentEl.querySelector('p.attach-img');
              
              // 날짜
              const dateEl = commentEl.querySelector('span.date');
              let date = '';
              if (dateEl) {
                const dateText = dateEl.textContent.trim();
                // '작성일2019.11.28.' 형식에서 날짜만 추출
                const dateMatch = dateText.match(/\d{4}\.\d{1,2}\.\d{1,2}/);
                date = dateMatch ? dateMatch[0] : dateText.replace(/작성일/i, '').trim();
              }
              
              // 좋아요 수
              const likeEl = commentEl.querySelector('span.like, a.like');
              let likes = 0;
              if (likeEl) {
                const likeText = likeEl.textContent.trim();
                if (likeText !== '좋아요' && likeText !== '좋아요수좋아요') {
                  const likeMatch = likeText.match(/\d+/);
                  if (likeMatch) {
                    likes = parseInt(likeMatch[0]);
                  }
                }
              }
              
              // 대댓글 여부 확인 - class="wrap-reply" 내부에 있으면 대댓글
              const isReply = !!commentEl.closest('.wrap-reply');
              
              // 대댓글 수
              const commentCountEl = commentEl.querySelector('span.cmt');
              let commentCount = 0;
              if (commentCountEl) {
                const cmtText = commentCountEl.textContent.trim();
                if (cmtText !== '대댓글') {
                  const cmtMatch = cmtText.match(/\d+/);
                  if (cmtMatch) {
                    commentCount = parseInt(cmtMatch[0]);
                  }
                }
              }
              
              // 댓글 ID (고유 ID 속성 가져오기)
              const commentId = commentEl.id || '';
              
              results.push({
                id: commentId,
                nickname,
                company,
                content,
                date,
                likes,
                hasImage,
                commentCount,
                isReply,
                isAuthor
              });
            } catch (e) {
              console.error('댓글 파싱 중 오류:', e);
            }
          }
          
          return results;
        });
        
        return comments;
      } catch (e) {
        console.error('댓글 수집 중 오류:', e);
        return [];
      }
    };
    
    // 무한 스크롤 처리
    while (!isEnd && scrollCount < 20 && posts.length < maxPosts) { // 최대 20회 스크롤 또는 설정한 게시물 수에 도달할 때까지
      // 현재 스크랩된 게시물 개수 출력
      console.log(`현재 ${posts.length}개의 게시물이 스크랩되었습니다. (목표: ${maxPosts}개)`);
      
      // 게시물 목록 가져오기
      const newPosts = await page.evaluate(async (currentPosts, keyword) => {
        const postElements = Array.from(document.querySelectorAll('.article-list-pre:not(.article-list-ad):not(.coupang-ad)'));
        const results = [];
        
        for (const postEl of postElements) {
          try {
            // 이미 수집한 게시물인지 확인 (URL로 체크)
            const postUrl = postEl.querySelector('.tit a') ? postEl.querySelector('.tit a').href : null;
            if (!postUrl || currentPosts.some(p => p.url === postUrl)) continue;
            
            // 제목
            const title = postEl.querySelector('.tit h3') ? postEl.querySelector('.tit h3').textContent.trim() : '';
            
            // 내용 미리보기
            const previewText = postEl.querySelector('.pre-txt a') ? postEl.querySelector('.pre-txt a').textContent.trim() : '';
            
            // 작성자 정보
            const authorElement = postEl.querySelector('.sub .name a');
            const authorText = authorElement ? authorElement.textContent.trim() : '';
            // 회사와 사용자명 분리
            const authorParts = authorText.split('·');
            const company = authorParts[0]?.trim() || '';
            const author = authorParts[1]?.trim() || '';
            
            // 조회수
            const viewElement = postEl.querySelector('.pv');
            const views = viewElement ? 
              parseInt(viewElement.textContent.replace(/[^0-9]/g, '')) : 0;
            
            // 좋아요
            const likeElement = postEl.querySelector('.like');
            const likeText = likeElement ? likeElement.textContent.trim() : '좋아요';
            const likes = likeText !== '좋아요' ? parseInt(likeText.replace(/[^0-9]/g, '')) : 0;
            
            // 댓글 수
            const commentElement = postEl.querySelector('.cmt');
            const commentCount = commentElement ? 
              parseInt(commentElement.textContent.replace(/[^0-9]/g, '')) : 0;
            
            // 날짜
            const dateElement = postEl.querySelector('.past');
            const date = dateElement ? dateElement.textContent.replace(/[_작성시간_]/g, '').trim() : '';
            
            // 카테고리
            const categoryElement = postEl.querySelector('.category .topic-name');
            const category = categoryElement ? categoryElement.textContent.trim() : '';
            
            results.push({
              keyword,
              title,
              url: postUrl,
              preview: previewText,
              company,
              author,
              category,
              date,
              views,
              likes,
              commentCount,
              fullContent: '', // 나중에 상세 페이지에서 채울 예정
              comments: [] // 댓글은 나중에 수집
            });
          } catch (e) {
            console.error('게시물 파싱 중 오류:', e);
          }
        }
        
        return results;
      }, posts, searchKeyword);
      
      // 새 게시물 추가
      posts.push(...newPosts);
      
      // 설정한 최대 게시물 수를 초과한 경우 잘라내기
      if (posts.length > maxPosts) {
        console.log(`설정한 최대 게시물 수(${maxPosts}개)를 초과했습니다. 초과분을 제거합니다.`);
        posts = posts.slice(0, maxPosts);
        isEnd = true; // 스크롤 중단
      }
      
      // 새 게시물이 추가되었으면 임시 파일에 저장
      if (newPosts.length > 0) {
        saveTemporaryData();
      }
      
      // 스크롤 내리기
      previousHeight = await page.evaluate('document.body.scrollHeight');
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      
      // 로딩 대기 (직접 타임아웃 처리)
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 스크롤이 더 이상 내려가지 않는지 확인
      const currentHeight = await page.evaluate('document.body.scrollHeight');
      if (currentHeight === previousHeight) {
        isEnd = true;
        console.log('더 이상 스크롤 할 수 없습니다. 스크래핑을 종료합니다.');
      }
      
      scrollCount++;
    }
    
    console.log(`총 ${posts.length}개의 게시물을 찾았습니다.`);
    
    // 게시물 상세 내용 수집
    console.log("이제 각 게시물의 상세 내용을 수집합니다.");
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      
      // 이미 상세 내용이 수집된 게시물 건너뛰기
      if (post.fullContent && post.fullContent.length > 0) {
        console.log(`게시물 ${i+1}/${posts.length} "${post.title}"의 상세 내용은 이미 수집되었습니다.`);
        continue;
      }
      
      console.log(`게시물 ${i+1}/${posts.length} "${post.title}" 상세 내용 수집 중...`);
      
      try {
        // 본문 수집
        const fullContent = await collectFullContent(post.url);
        posts[i].fullContent = fullContent;
        console.log(`게시물 "${post.title}"의 본문 내용을 수집했습니다. 글자 수: ${fullContent.length}`);
        
        // 댓글 수집
        if (saveComments) {
          const comments = await collectComments(post.url);
          posts[i].comments = comments.filter(c => c.content && c.content.trim().length > 0);
          console.log(`게시물 "${post.title}"에서 총 ${posts[i].comments.length}개의 댓글을 수집했습니다.`);
        }
        
        // 중간 저장
        saveTemporaryData();
        
        // 과도한 요청을 방지하기 위한 지연
        await new Promise(resolve => setTimeout(resolve, 1500));
      } catch (e) {
        console.error(`게시물 "${post.title}" 상세 내용 수집 중 오류:`, e);
        saveTemporaryData(); // 오류가 있어도 중간 저장
      }
    }
    
    // 최종 결과 저장
    fs.writeFileSync(outputPath, JSON.stringify({
      keyword: searchKeyword,
      count: posts.length,
      lastUpdated: new Date().toISOString(),
      posts: posts
    }, null, 2));
    
    console.log(`스크래핑이 완료되었습니다. 결과는 ${outputPath} 파일에 저장되었습니다.`);
    
    // 임시 파일 삭제
    if (fs.existsSync(tempOutputPath)) {
      fs.unlinkSync(tempOutputPath);
      console.log(`임시 파일 ${tempOutputPath}이 삭제되었습니다.`);
    }
    
    // 브라우저 종료
    await browser.close();
    
    return posts;
  } catch (error) {
    console.error('스크래핑 중 오류가 발생했습니다:', error);
    
    // 오류가 발생해도 중간 결과 저장
    if (posts.length > 0) {
      fs.writeFileSync(tempOutputPath, JSON.stringify({
        keyword: searchKeyword,
        count: posts.length,
        lastUpdated: new Date().toISOString(),
        error: error.message,
        posts: posts
      }, null, 2));
      console.log(`오류가 발생했지만 중간 결과는 ${tempOutputPath}에 저장되었습니다.`);
    }
    
    await browser.close();
    throw error;
  }
}

// 실행 부분
const searchKeyword = '폰 대리점'; // 검색할 키워드 설정
const maxPostsToCollect = 10; // 최대 수집할 게시물 수 설정

// 설정 객체 생성
const crawlerConfig = {
  keyword: searchKeyword,
  maxPosts: maxPostsToCollect,
  saveComments: true // 댓글도 함께 수집할지 여부
};

scrapeTeamblind(crawlerConfig)
  .then(() => console.log('스크래핑 프로세스가 성공적으로 완료되었습니다.'))
  .catch(err => console.error('스크래핑 중 오류가 발생했습니다:', err));